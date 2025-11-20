const express = require('express');
const cors = require('cors');
const { S3 } = require('@aws-sdk/client-s3');
const pdfParse = require('pdf-parse');
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

// Парсинг конкретного PDF файла
app.get('/api/parse/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    // Скачиваем PDF из S3
    const pdfData = await s3.getObject({
      Bucket: 'faktura35',
      Key: `С-фактура(PDF)/${filename}`
    });
    
    // Парсим PDF
    const data = await pdfParse(pdfData.Body);
    
    // Извлекаем данные из текста
    const extractedData = extractDataFromText(data.text, filename);
    
    res.json({
      filename: filename,
      text: data.text, // весь текст из PDF
      extractedData: extractedData
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Функция извлечения данных из текста PDF
function extractDataFromText(text, filename) {
  // Пока простой парсинг - завтра улучшим
  return {
    date: extractDate(text, filename),
    number: extractNumber(text, filename),
    amount: extractAmount(text, filename),
    nds: extractNDS(text, filename),
    supplier: "Извлекается...",
    status: "parsed"
  };
}

// Вспомогательные функции для парсинга
function extractDate(text, filename) {
  // Пока из имени файла
  const match = filename.match(/(\d{2}\.\d{2}\.\d{2})/);
  return match ? match[1] : "не найдена";
}

function extractNumber(text, filename) {
  const match = filename.match(/№\s*(\d+-\d+)/);
  return match ? match[1] : "не найден";
}

function extractAmount(text, filename) {
  const match = filename.match(/=\s*([\d.]+)/);
  return match ? parseFloat(match[1]) : 0;
}

function extractNDS(text, filename) {
  const match = filename.match(/НДС\s*([\d.]+)/);
  return match ? parseFloat(match[1]) : 0;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});