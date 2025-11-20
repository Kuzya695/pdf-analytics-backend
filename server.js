const express = require('express');
const cors = require('cors');
const { S3 } = require('@aws-sdk/client-s3');
const app = express();

app.use(cors());
app.use(express.json());

// Yandex Cloud S3 клиент
const s3 = new S3({
  endpoint: 'https://storage.yandexcloud.net',
  region: 'ru-central1',
  credentials: {
    accessKeyId: process.env.YANDEX_ACCESS_KEY,
    secretAccessKey: process.env.YANDEX_SECRET_KEY
  }
});

// Тестовый endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'PDF Analytics Backend работает!' });
});

// Список PDF файлов
app.get('/api/files', async (req, res) => {
  try {
    const result = await s3.listObjectsV2({
      Bucket: 'faktura35',
      Prefix: 'С-фактура(PDF)/'
    });
    
    const pdfFiles = result.Contents
      .filter(item => item.Key.endsWith('.pdf'))
      .map(item => ({
        name: item.Key.split('/').pop(),
        key: item.Key,
        size: item.Size,
        lastModified: item.LastModified
      }));

    res.json({ files: pdfFiles });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});