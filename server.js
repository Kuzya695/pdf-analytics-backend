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
    
    // Конвертируем Buffer в Uint8Array для pdf-parse
    const pdfBuffer = await pdfData.Body.transformToByteArray();
    
    // Парсим PDF
    const data = await pdfParse(pdfBuffer);
    
    // Извлекаем данные из текста
    const extractedData = extractDataFromText(data.text, filename);
    
    res.json({
      filename: filename,
      extractedData: extractedData
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Функция извлечения данных из текста PDF
function extractDataFromText(text, filename) {
  return {
    date: extractDateFormatted(text),
    contractor: extractContractor(text),
    amount: extractAmount(text, filename),
    incomingNumber: extractIncomingNumber(text),
    comment: extractComment(text)
  };
}

// Вспомогательные функции для парсинга
function extractDateFormatted(text) {
  // Ищем дату в формате "16 ноября 2025 г." и конвертируем в "16.11.2025"
  const match = text.match(/(\d{1,2})\s+(ноября|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/i);
  if (match) {
    const months = {
      'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
      'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
      'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
    };
    const day = match[1].padStart(2, '0');
    const month = months[match[2].toLowerCase()];
    const year = match[3];
    return `${day}.${month}.${year}`;
  }
  
  // Если не нашли, пробуем из имени файла
  const filenameMatch = filename.match(/(\d{2})\.(\d{2})\.(\d{2})/);
  if (filenameMatch) {
    const day = filenameMatch[1];
    const month = filenameMatch[2];
    const year = `20${filenameMatch[3]}`;
    return `${day}.${month}.${year}`;
  }
  
  return "не найдена";
}

function extractContractor(text) {
  // Ищем продавца/поставщика
  const match = text.match(/Продавец\s+([^\n]+)/);
  return match ? match[1].trim() : "";
}

function extractAmount(text, filename) {
  // Сначала из имени файла
  const filenameMatch = filename.match(/=\s*([\d.]+)/);
  if (filenameMatch) return parseFloat(filenameMatch[1]);
  
  // Потом из текста PDF
  const textMatch = text.match(/Всего к оплате[\s\S]*?([\d.,]+)/);
  if (textMatch) return parseFloat(textMatch[1].replace(',', '.'));
  
  return 0;
}

function extractIncomingNumber(text) {
  // Ищем номер счета-фактуры
  const match = text.match(/Счет-фактура\s+No?\s*(\d+\/\d+)/);
  return match ? match[1] : "";
}

function extractComment(text) {
  // Ищем комментарий из "Счет-Оферта № 0134086922-0566"
  const match = text.match(/Счет-Оферта\s+№?\s*\d+-(\d+)/);
  return match ? match[1] : "";
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});