const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Тестовый endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'PDF Analytics Backend работает!' });
});

// Новый endpoint для списка PDF файлов
app.get('/api/files', (req, res) => {
  res.json({ 
    message: 'Здесь будет список PDF файлов из Yandex Cloud',
    files: []
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});