require("dotenv").config();
const cron = require("node-cron");
const sendWhatsAppMessage = require("./sendMessage");
const supabase = require("./supabase");
const { ensureRowExists } = require("./usage");

const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Singapore";
const REMINDER_TEMPLATE_NAME = process.env.REMINDER_TEMPLATE_NAME || "";
const REMINDER_TEMPLATE_LANGUAGE = process.env.REMINDER_TEMPLATE_LANGUAGE || "en_US";

function scheduledMessageOptions() {
  return REMINDER_TEMPLATE_NAME
    ? { templateName: REMINDER_TEMPLATE_NAME, languageCode: REMINDER_TEMPLATE_LANGUAGE }
    : {};
}

function getLocalComponents() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });

  const [{ value: day }, , { value: month }] = formatter.formatToParts(now);

  const dowFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    weekday: "short",
  });
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dowStr = dowFormatter.format(now).slice(0, 3);

  return {
    day: parseInt(day),
    month: parseInt(month),
    dayOfWeek: dowMap[dowStr],
    todayLocal: new Intl.DateTimeFormat("en-CA", {
      timeZone: APP_TIMEZONE,
    }).format(now),
    timeStr: new Intl.DateTimeFormat("en-GB", {
      timeZone: APP_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now),
  };
}

// Guard flags — prevent overlapping executions
let reminderRunning = false;
let routineRunning = false;
let recurringRunning = false;
let eventAlertRunning = false;

// Heartbeat tracking (in-memory fallback for dashboard)
const lastHeartbeats = {
  "Reminder Dispatch": null,
  "Routine Dispatch": null,
  "Recurring Task Dispatch": null,
  "Event Alert": null,
};

async function recordHeartbeat(jobName) {
  const now = new Date().toISOString();
  lastHeartbeats[jobName] = now;
  try {
    await ensureRowExists();
    await supabase
      .from("system_jobs")
      .upsert({ job_name: jobName, last_fired: now, status: "active" }, { onConflict: "job_name" });
  } catch (_) {
    // in-memory fallback already set
  }
}

// -----------------------------------------------------------------------
// Exported dispatch functions — called by both cron AND /api/tick
// -----------------------------------------------------------------------

async function runReminderDispatch() {
  if (reminderRunning) return;
  reminderRunning = true;

  try {
    const now = new Date().toISOString();

    const { data: dueReminders } = await supabase
      .from("personal_reminders")
      .select("*")
      .lte("reminder_time", now)
      .eq("status", "pending");

    for (const reminder of dueReminders || []) {
      const isNagReminder =
        typeof reminder.group_name === "string" && reminder.group_name.startsWith("nag:");
      const nagIntervalMinutes = isNagReminder
        ? Math.max(5, parseInt(reminder.group_name.split(":")[1], 10) || 60)
        : null;

      if (isNagReminder) {
        // Reschedule before sending so this row stays pending until the user says DONE.
        // The conditional update also acts as an atomic claim if two dispatchers overlap.
        const nextReminderTime = new Date(
          Date.now() + nagIntervalMinutes * 60 * 1000
        ).toISOString();

        const { data: claimed } = await supabase
          .from("personal_reminders")
          .update({ reminder_time: nextReminderTime })
          .eq("id", reminder.id)
          .eq("status", "pending")
          .lte("reminder_time", now)
          .select("id");
        if (!claimed?.length) continue;

        try {
          const body =
            `🔔 ${reminder.message}\n\nReply *DONE* when finished, or *SNOOZE 30* to pause for 30 minutes.`;
          await sendWhatsAppMessage(reminder.phone, body, scheduledMessageOptions());
        } catch (_) {
          // Restore the original due time so the next scheduler tick retries.
          await supabase
            .from("personal_reminders")
            .update({ reminder_time: reminder.reminder_time })
            .eq("id", reminder.id)
            .eq("status", "pending");
        }
        continue;
      }

      // Standard one-off / finite interval reminders complete after being claimed.
      const { data: claimed } = await supabase
        .from("personal_reminders")
        .update({ status: "completed" })
        .eq("id", reminder.id)
        .eq("status", "pending")
        .select("id");
      if (!claimed?.length) continue;

      try {
        await sendWhatsAppMessage(reminder.phone, reminder.message, scheduledMessageOptions());
      } catch (_) {
        await supabase.from("personal_reminders").update({ status: "pending" }).eq("id", reminder.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    reminderRunning = false;
    await recordHeartbeat("Reminder Dispatch");
  }
}

async function runRoutineDispatch() {
  if (routineRunning) return;
  routineRunning = true;

  try {
    const { timeStr, todayLocal } = getLocalComponents();

    const { data: routines } = await supabase
      .from("daily_routines")
      .select("*")
      .eq("is_active", true)
      .or(`last_fired_date.is.null,last_fired_date.neq.${todayLocal}`);

    for (const routine of routines || []) {
      if (timeStr < routine.reminder_time.slice(0, 5)) continue;

      const { data: claimed } = await supabase
        .from("daily_routines")
        .update({ last_fired_date: todayLocal })
        .eq("id", routine.id)
        .or(`last_fired_date.is.null,last_fired_date.neq.${todayLocal}`)
        .select("id");
      if (!claimed?.length) continue;

      try {
        await sendWhatsAppMessage(routine.phone, routine.task_name, scheduledMessageOptions());
      } catch (_) {
        await supabase.from("daily_routines").update({ last_fired_date: null }).eq("id", routine.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    routineRunning = false;
    await recordHeartbeat("Routine Dispatch");
  }
}

async function runRecurringDispatch() {
  if (recurringRunning) return;
  recurringRunning = true;

  try {
    const { day, dayOfWeek, timeStr, todayLocal } = getLocalComponents();

    const { data: tasks } = await supabase
      .from("recurring_tasks")
      .select("*")
      .eq("is_active", true)
      .or(`last_fired_date.is.null,last_fired_date.neq.${todayLocal}`);

    for (const task of tasks || []) {
      if (timeStr < task.reminder_time.slice(0, 5)) continue;

      let shouldFire = false;
      if (task.recurrence_type === "weekly") {
        shouldFire = task.day_of_week === dayOfWeek;
      } else if (task.recurrence_type === "monthly") {
        const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: APP_TIMEZONE }));
        const tomorrowLocal = new Date(nowLocal);
        tomorrowLocal.setDate(tomorrowLocal.getDate() + 1);
        const isLastDayOfMonth = tomorrowLocal.getDate() === 1;
        shouldFire = (isLastDayOfMonth && task.day_of_month > day) || task.day_of_month === day;
      }

      if (!shouldFire) continue;

      const { data: claimed } = await supabase
        .from("recurring_tasks")
        .update({ last_fired_date: todayLocal })
        .eq("id", task.id)
        .or(`last_fired_date.is.null,last_fired_date.neq.${todayLocal}`)
        .select("id");
      if (!claimed?.length) continue;

      try {
        await sendWhatsAppMessage(task.phone, task.task_name, scheduledMessageOptions());
      } catch (_) {
        await supabase.from("recurring_tasks").update({ last_fired_date: null }).eq("id", task.id);
      }
    }
  } catch (_) {
    // DB error — will retry next cycle
  } finally {
    recurringRunning = false;
    await recordHeartbeat("Recurring Task Dispatch");
  }
}

// -----------------------------------------------------------------------
// Cron jobs — fire every minute.
// /api/tick calls the same functions when the process wakes from sleep.
// -----------------------------------------------------------------------

cron.schedule("* * * * *", runReminderDispatch);
cron.schedule("* * * * *", runRoutineDispatch);
cron.schedule("* * * * *", runRecurringDispatch);

// Special event alerts — 08:30 in the configured local timezone.
cron.schedule("30 8 * * *", async () => {
  if (eventAlertRunning) return;
  eventAlertRunning = true;
  try {
    const { day: todayDay, month: todayMonth } = getLocalComponents();

    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowDay = tomorrowDate.getDate();
    const tomorrowMonth = tomorrowDate.getMonth() + 1;

    const { data: events } = await supabase.from("special_events").select("*");
    if (!events) return;

    for (const event of events) {
      const eDate = new Date(event.event_date);
      const eDay = eDate.getDate();
      const eMonth = eDate.getMonth() + 1;

      if (eDay === todayDay && eMonth === todayMonth) {
        await sendWhatsAppMessage(event.phone, `${event.person_name}'s ${event.event_type} is today.`);
      } else if (eDay === tomorrowDay && eMonth === tomorrowMonth) {
        await sendWhatsAppMessage(event.phone, `${event.person_name}'s ${event.event_type} is tomorrow.`);
      }
    }
  } catch (_) {
    // silent
  } finally {
    eventAlertRunning = false;
    await recordHeartbeat("Event Alert");
  }
}, { timezone: APP_TIMEZONE });

module.exports = {
  getHeartbeats: () => lastHeartbeats,
  runReminderDispatch,
  runRoutineDispatch,
  runRecurringDispatch,
};
