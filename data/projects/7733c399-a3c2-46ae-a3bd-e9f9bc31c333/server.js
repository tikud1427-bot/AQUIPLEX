require('dotenv').config();
const express = require('express');
const app = express();
const port = process.env.PORT || 3000; // default port if not set

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/api/health', (req, res) => {
  res.status(200).send({ message: 'Server is healthy' });
});

app.get('/api/ranking', (req, res) => {
  // dummy ranking data
  const ranking = [
    { name: 'Player 1', score: 1000 },
    { name: 'Player 2', score: 900 },
    { name: 'Player 3', score: 800 },
  ];
  res.json(ranking);
});

app.post('/api/submit-score', (req, res) => {
  const { name, score } = req.body;
  console.log(`New score submitted: ${name} - ${score}`);
  res.status(201).send({ message: 'Score submitted successfully' });
});

app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
process.on('SIGINT', () => {
  console.log('Server stopped');
  process.exit(0);
});