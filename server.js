const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(express.json());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const CHANNEL_ID = "TVŮJ_CHANNEL_ID"; // sem dáš ID kanálu

client.once("ready", () => {
    console.log("Renux RP Logger běží");
});

app.post("/log", (req, res) => {
    const { title, message, color, server } = req.body;

    const channel = client.channels.cache.get(CHANNEL_ID);
    channel.send({
        embeds: [{
            title: `${server} – ${title}`,
            description: message,
            color: color,
            footer: { text: "Renux RP Logger" }
        }]
    });

    res.send("OK");
});

client.login("TVŮJ_TOKEN"); // sem dáš token bota
app.listen(3000); // port, na kterém bot poslouchá
