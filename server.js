const express = require('express');
const cors = require('cors');
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const pdfParse = require('pdf-parse');
const app = express();

app.use(cors());
app.use(express.json());

// Yandex Cloud S3 клиент
const s3 = new S3Client({
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
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: 'faktura35',
      Prefix: 'С-фактура(PDF)/'
    }));
    
    const pdfFiles = result.Contents
      .filter(item => item.Key && item.Key.endsWith('.pdf'))
      .map(item => ({
        name: item.Key.split('/').pop(),
        key: item.Key,
        size: item.Size,
        lastModified: item.LastModified
      }));

    res.json({ files: pdfFiles });
  } catch (error) {
    console.error('Ошибка получения списка файлов:', error);
    res.status(500).json({ error: error.message });
  }
});

// Парсинг конкретного PDF файла
app.get('/api/parse/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    // Скачиваем PDF из S3
    const pdfData = await s3.send(new GetObjectCommand({
      Bucket: 'faktura35',
      Key: `С-фактура(PDF)/${filename}`
    }));
    
    // Конвертируем поток в Buffer
    const chunks = [];
    for await (const chunk of pdfData.Body) {
      chunks.push(chunk);
    }
    const pdfBuffer = Buffer.concat(chunks);
    
    // Парсим PDF
    const data = await pdfParse(pdfBuffer);
    
    // Извлекаем данные из текста
    const extractedData = extractDataFromText(data.text, filename);
    
    res.json({
      filename: filename,
      extractedData: extractedData
    });
  } catch (error) {
    console.error('Ошибка парсинга PDF:', error);
    res.status(500).json({ error: error.message });
  }
});

// Эндпоинт для скачивания PDF файла - РЕДИРЕКТ НА S3
app.get('/api/download/:filename', async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    console.log('📥 Запрос на скачивание:', filename);
    
    // Редирект на прямую ссылку S3
    const directUrl = `https://storage.yandexcloud.net/faktura35/С-фактура(PDF)/${encodeURIComponent(filename)}`;
    console.log('🔗 Редирект на:', directUrl);
    
    res.redirect(directUrl);
    
  } catch (error) {
    console.error('❌ Ошибка:', error);
    res.status(500).json({ error: error.message });
  }
});

// Функция извлечения данных из текста PDF
function extractDataFromText(text, filename) {
  return {
    date: extractDateFormatted(text, filename),
    contractor: extractContractor(text),
    amount: extractAmount(text, filename),
    incomingNumber: extractIncomingNumber(text),
    comment: extractComment(text)
  };
}

// Вспомогательные функции для парсинга
function extractDateFormatted(text, filename) {
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
  
  // Ищем дату в формате "17.11.2025"
  const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dateMatch) {
    const day = dateMatch[1].padStart(2, '0');
    const month = dateMatch[2].padStart(2, '0');
    const year = dateMatch[3];
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
  // Ищем продавца/поставщика в разных вариантах
  const patterns = [
    /Продавец\s+([^\n]+)/i,
    /Поставщик\s+([^\n]+)/i,
    /ООО[^,\n]+/i,
    /АО[^,\n]+/i,
    /ПАО[^,\n]+/i,
    /ИП[^,\n]+/i,
    /"([^"]+)"/i  // Название в кавычках
  ];
  
  for (let pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const contractor = match[1] ? match[1].trim() : match[0].trim();
      if (contractor.length > 5) { // Фильтруем слишком короткие matches
        console.log(`🏢 Найден контрагент: ${contractor}`);
        return contractor;
      }
    }
  }
  
  return "";
}

function extractAmount(text, filename) {
  // 1. Сначала из имени файла
  const filenameMatch = filename.match(/=\s*([\d.]+)/);
  if (filenameMatch) return parseFloat(filenameMatch[1]);
  
  // 2. Ищем "Всего к оплате" в разных вариантах написания
  const totalPatterns = [
    /Всего к оплате[\s\S]*?([\d\s.,]+)\s*₽/i,
    /Всего к оплате[\s\S]*?₽\s*([\d\s.,]+)/i,
    /Сумма к оплате[\s\S]*?([\d\s.,]+)\s*₽/i,
    /Стоимость с налогом[\s\S]*?([\d\s.,]+)\s*₽/i,
    /Итого[\s\S]*?([\d\s.,]+)\s*₽/i,
    /Всего[\s\S]*?([\d\s.,]+)\s*₽/i
  ];
  
  for (let pattern of totalPatterns) {
    const match = text.match(pattern);
    if (match) {
      const amount = parseFloat(match[1].replace(/\s/g, '').replace(',', '.'));
      if (!isNaN(amount) && amount > 0) {
        console.log(`💰 Найдена сумма по паттерну: ${amount}`);
        return amount;
      }
    }
  }
  
  // 3. Ищем последнюю сумму в таблице (последняя колонка последней строки)
  const tableRows = text.split('\n').filter(line => line.trim() !== '');
  for (let i = tableRows.length - 1; i >= 0; i--) {
    const row = tableRows[i];
    // Ищем числа с разделителями тысяч и десятичными знаками
    const amountMatches = row.match(/(\d{1,3}(?:\s\d{3})*[,.]\d{2})/g);
    if (amountMatches && amountMatches.length > 0) {
      const lastAmount = amountMatches[amountMatches.length - 1];
      const amount = parseFloat(lastAmount.replace(/\s/g, '').replace(',', '.'));
      if (!isNaN(amount) && amount > 0) {
        console.log(`💰 Найдена сумма в таблице: ${amount}`);
        return amount;
      }
    }
  }
  
  // 4. Ищем любые крупные суммы в тексте
  const largeAmounts = text.match(/(\d{1,3}(?:\s\d{3})*[,.]\d{2})/g);
  if (largeAmounts) {
    // Берем максимальную сумму (скорее всего это итоговая)
    const amounts = largeAmounts.map(amt => 
      parseFloat(amt.replace(/\s/g, '').replace(',', '.'))
    ).filter(amt => !isNaN(amt) && amt > 10); // Фильтруем маленькие суммы
    
    if (amounts.length > 0) {
      const maxAmount = Math.max(...amounts);
      console.log(`💰 Найдена максимальная сумма в тексте: ${maxAmount}`);
      return maxAmount;
    }
  }
  
  console.log('❌ Сумма не найдена');
  return 0;
}

function extractIncomingNumber(text) {
  // Ищем номер счета-фактуры в разных форматах
  const patterns = [
    /Счет-фактура\s+No?\s*(\d+\/\d+)/i,      // "Счет-фактура No 18565/26547"
    /Счет-фактура\s+No?\s*(\d+)/i,           // "Счет-фактура No 58138246"
    /Счет-фактура\s+№\s*(\d+\/\d+)/i,        // с русским №
    /Счет-фактура\s+№\s*(\d+)/i,             // с русским № без слеша
    /№\s*(\d+\/\d+)\s+от/i,                   // "№ 18565/26547 от"
    /№\s*(\d+)\s+от/i,                        // "№ 58138246 от"
    /документ об отгрузке[^]*?№\s*(\d+\/\d+)/i, // в разделе документа об отгрузке
    /документ об отгрузке[^]*?№\s*(\d+)/i,
    /(\d{5,}\/\d{2,})/i,                     // любой номер с слешем (5+ цифр/2+ цифр)
    /(\d{6,})/i,                              // любой длинный номер (6+ цифр)
    /Счет-фактура[^]*?(\d+\/\d+)/i,          // номер после "Счет-фактура"
    /Счет-фактура[^]*?(\d+)/i
  ];
  
  for (let pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const number = match[1].trim();
      console.log(`🔢 Найден номер по паттерну: ${number}`);
      return number;
    }
  }
  
  console.log('❌ Номер не найден в тексте');
  return "не найден";
}

function extractComment(text) {
  // Ищем в разных вариантах написания
  const patterns = [
    /Счет-Оферта\s+No\s*(\d+)-(\d+)/i,  // "Счет-Оферта No 0134086922-0566"
    /Счет-Оферта\s+№\s*(\d+)-(\d+)/i,   // с русским №
    /Счет-Оферта[^]*?(\d{4})/i           // ищем 4 цифры после
  ];
  
  for (let pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Возвращаем последние 4 цифры (0566)
      if (match[2]) return match[2];
      if (match[1] && match[1].length >= 4) return match[1].slice(-4);
      if (match[1]) return match[1];
    }
  }
  
  return "";
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});