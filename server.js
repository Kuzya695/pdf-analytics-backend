// server.js - ОБНОВЛЕННЫЙ С ИСПРАВЛЕННЫМ ПАРСИНГОМ РУССКОГО ТЕКСТА
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

// 🔧 УЛУЧШЕННЫЕ ФУНКЦИИ ПАРСИНГА С ОБРАБОТКОЙ РУССКОГО ТЕКСТА

// Функция исправления проблем с кодировкой русского текста
function fixRussianEncoding(text) {
  if (!text) return '';
  
  return text
    // Исправляем common issues с русской кодировкой
    .replace(/or/g, 'от')
    .replace(/hon6pa/g, 'ноября')
    .replace(/Cuer/g, 'Счет')
    .replace(/中axrypa/g, 'фактура')
    .replace(/npaawepe/g, 'приложение')
    .replace(/N°/g, '№')
    .replace(/No/g, '№')
    // Восстанавливаем кириллицу из искаженных символов
    .replace(/Pewenua/g, 'Решения')
    .replace(/Vintep/g, 'Интер')
    .replace(/OOO/g, 'ООО')
    // Убираем лишние пробелы
    .replace(/\s+/g, ' ')
    .trim();
}

// Улучшенная функция извлечения данных
function extractDataFromText(text, filename) {
  // ПРЕДВАРИТЕЛЬНАЯ ОБРАБОТКА ТЕКСТА
  const cleanedText = fixRussianEncoding(text);
  
  console.log('📄 Оригинальный текст:', text.substring(0, 500));
  console.log('🔧 Очищенный текст:', cleanedText.substring(0, 500));
  
  return {
    date: extractDateFormatted(cleanedText, filename),
    contractor: extractContractor(cleanedText),
    amount: extractAmount(cleanedText, filename),
    incomingNumber: extractIncomingNumber(cleanedText),
    comment: extractComment(cleanedText)
  };
}

// Улучшенное извлечение даты
function extractDateFormatted(text, filename) {
  // Вариант 1: Ищем в формате "16 ноября 2025 г."
  const dateMatch1 = text.match(/(\d{1,2})\s+(ноября|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})\s*г?/i);
  if (dateMatch1) {
    const months = {
      'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
      'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
      'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
    };
    const day = dateMatch1[1].padStart(2, '0');
    const month = months[dateMatch1[2].toLowerCase()];
    const year = dateMatch1[3];
    return `${day}.${month}.${year}`;
  }
  
  // Вариант 2: Ищем в формате "16.11.2025"
  const dateMatch2 = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dateMatch2) {
    const day = dateMatch2[1].padStart(2, '0');
    const month = dateMatch2[2].padStart(2, '0');
    const year = dateMatch2[3];
    return `${day}.${month}.${year}`;
  }
  
  // Вариант 3: Из имени файла
  const filenameMatch = filename.match(/(\d{2})\.(\d{2})\.(\d{2,4})/);
  if (filenameMatch) {
    const day = filenameMatch[1];
    const month = filenameMatch[2];
    const year = filenameMatch[3].length === 2 ? `20${filenameMatch[3]}` : filenameMatch[3];
    return `${day}.${month}.${year}`;
  }
  
  return "не найдена";
}

// Улучшенное извлечение контрагента
function extractContractor(text) {
  // Ищем в разных вариантах
  const patterns = [
    /Продавец[:\s]+([^\n\r]+)/i,
    /Поставщик[:\s]+([^\n\r]+)/i,
    /ООО[^,\n\r]+/i,
    /ИП[^,\n\r]+/i,
    /АО[^,\n\r]+/i
  ];
  
  for (let pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const contractor = match[1] || match[0];
      return contractor.trim().replace(/,$/, '');
    }
  }
  
  return "";
}

// Улучшенное извлечение суммы
function extractAmount(text, filename) {
  // Сначала из имени файла
  const filenameMatch = filename.match(/=\s*([\d.,]+)/);
  if (filenameMatch) {
    const amount = parseFloat(filenameMatch[1].replace(',', '.'));
    if (!isNaN(amount)) return amount;
  }
  
  // Потом из текста PDF - ищем разные варианты
  const amountPatterns = [
    /Всего к оплате[\s\S]*?([\d\s.,]+)/i,
    /Сумма[\s\S]*?([\d\s.,]+)/i,
    /Итого[\s\S]*?([\d\s.,]+)/i,
    /К оплате[\s\S]*?([\d\s.,]+)/i,
    /([\d\s.,]+)\s*руб/i
  ];
  
  for (let pattern of amountPatterns) {
    const match = text.match(pattern);
    if (match) {
      const amountStr = match[1].replace(/\s/g, '').replace(',', '.');
      const amount = parseFloat(amountStr);
      if (!isNaN(amount) && amount > 0) return amount;
    }
  }
  
  return 0;
}

// 🔥 УЛУЧШЕННОЕ ИЗВЛЕЧЕНИЕ ВХОДЯЩЕГО НОМЕРА
function extractIncomingNumber(text) {
  // Ищем номер счета-фактуры в разных форматах
  const patterns = [
    /Счет-фактура\s*[№N]?\s*(\d+\/\d+)/i,  // "Счет-фактура № 58138246/26547"
    /Счет-фактура\s*[№N]?\s*(\d+)/i,       // "Счет-фактура № 58138246"
    /[№N]\s*(\d+\/\d+)/,                   // "№ 18565/26547"
    /[№N]\s*(\d+)/,                        // "№ 18565"
    /(\d+\/\d+)/,                          // Просто "18565/26547"
    /вх[.\s]*[№N]?\s*(\d+\/\d+)/i,        // "вх. № 18565/26547"
    /вх[.\s]*[№N]?\s*(\d+)/i              // "вх. № 18565"
  ];
  
  for (let pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      console.log('🔍 Найден номер:', match[1]);
      return match[1];
    }
  }
  
  console.log('❌ Номер не найден в тексте');
  return "";
}

// Улучшенное извлечение комментария
function extractComment(text) {
  // Ищем в разных вариантах написания Счет-Оферты
  const patterns = [
    /Счет-Оферта\s*[№N]?\s*(\d+)-(\d+)/i,    // "Счет-Оферта № 0134086922-0566"
    /Счет-Оферта\s*[№N]?\s*(\d+)/i,          // "Счет-Оферта № 0134086922"
    /Оферта\s*[№N]?\s*(\d+)-(\d+)/i,         // "Оферта № 0134086922-0566"
    /Счет[-\s]Оферта[^]*?(\d{4})/i,          // ищем 4 цифры
    /Оферта[^]*?(\d{4})/i                    // ищем 4 цифры после Оферта
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

// 📊 НОВЫЙ ENDPOINT - ПАРСИНГ ВСЕХ ФАЙЛОВ СРАЗУ
app.get('/api/parse-all', async (req, res) => {
  try {
    console.log('🔄 Начинаем парсинг всех файлов...');
    
    // Получаем список файлов
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

    console.log(`📁 Найдено ${pdfFiles.length} PDF файлов`);

    // Парсим каждый файл
    const parsedData = [];
    
    for (const file of pdfFiles.slice(0, 10)) { // Ограничим первые 10 для теста
      try {
        console.log(`🔍 Парсим файл: ${file.name}`);
        
        const pdfData = await s3.getObject({
          Bucket: 'faktura35',
          Key: file.key
        });
        
        const pdfBuffer = await pdfData.Body.transformToByteArray();
        const data = await pdfParse(pdfBuffer);
        
        const extractedData = extractDataFromText(data.text, file.name);
        
        parsedData.push({
          filename: file.name,
          ...extractedData
        });
        
        console.log(`✅ Успешно: ${file.name}`, extractedData);
        
      } catch (fileError) {
        console.error(`❌ Ошибка парсинга ${file.name}:`, fileError.message);
        parsedData.push({
          filename: file.name,
          error: fileError.message
        });
      }
    }

    res.json({
      totalFiles: pdfFiles.length,
      parsedFiles: parsedData.length,
      data: parsedData
    });
    
  } catch (error) {
    console.error('💥 Критическая ошибка:', error);
    res.status(500).json({ error: error.message });
  }
});

// Существующие endpoints остаются без изменений
app.get('/health', (req, res) => {
  res.json({ status: 'PDF Analytics Backend работает!', version: '2.0 - улучшенный парсинг' });
});

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

app.get('/api/parse/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    console.log(`🔍 Запрос на парсинг: ${filename}`);
    
    const pdfData = await s3.getObject({
      Bucket: 'faktura35',
      Key: `С-фактура(PDF)/${filename}`
    });
    
    const pdfBuffer = await pdfData.Body.transformToByteArray();
    const data = await pdfParse(pdfBuffer);
    
    const extractedData = extractDataFromText(data.text, filename);
    
    res.json({
      filename: filename,
      extractedData: extractedData,
      debug: {
        textSample: data.text.substring(0, 500),
        cleanedText: fixRussianEncoding(data.text).substring(0, 500)
      }
    });
  } catch (error) {
    console.error('❌ Ошибка парсинга:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🔧 Версия: Улучшенный парсинг русского текста`);
});