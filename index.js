import express from "express";
const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = "candia123";

app.use(express.json());

app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado!");
    return res.status(200).send(challenge);
  } else {
    return res.status(403).send("Erro de verificação");
  }
});

app.post("/", (req, res) => {
  console.log("Evento recebido:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
