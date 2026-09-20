const axios = require("axios");

async function sendWhatsAppMessage(to, body, options = {}) {
  const url = `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const headers = {
    Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  const { templateName, languageCode = "en_US" } = options;
  const data = templateName
    ? {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
        },
      }
    : {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      };

  try {
    const response = await axios.post(url, data, { headers });
    console.log("Message sent:", response.data);
    return response.data;
  } catch (error) {
    console.error(
      "WhatsApp API Error:",
      error.response ? error.response.data : error.message
    );
    throw error;
  }
}

module.exports = sendWhatsAppMessage;
