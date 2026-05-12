require('dotenv').config();
const express = require('express');
const app = express();
const port = process.env.PORT;

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.get('/api/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});