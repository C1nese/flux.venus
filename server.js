const express = require("express");
const path = require("path");

const healthHandler = require("./api/health");
const stateHandler = require("./api/state");
const webhookHandler = require("./api/webhook");

const app = express();
const port = Number(process.env.PORT || 3000);

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(__dirname));

app.get("/api/health", healthHandler);
app.get("/api/state", stateHandler);
app.post("/api/webhook", webhookHandler);

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`Local server ready at http://localhost:${port}`);
  console.log("This local server mirrors the Vercel API routes with webhook-driven state.");
});
