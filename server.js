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
    
    // Парсим PDF с улучшенными настройками для русской кодировки
    const data = await pdfParse(pdfBuffer, {
      pagerender: renderPage,
      max: 0 // без ограничения длины текста
    });
    
    // Декодируем текст для исправления кодировки
    const decodedText = fixEncoding(data.text);
    console.log('📄 Распознанный текст:', decodedText);
    
    // Извлекаем данные из текста
    const extractedData = {
      date: (() => {
        // Ищем дату в разных форматах
        const datePatterns = [
          /(\d{1,2})\.(\d{1,2})\.(\d{4})/, // 17.11.2025
          /(\d{1,2})\s+(ноября|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/i
        ];
        
        for (let pattern of datePatterns) {
          const match = decodedText.match(pattern);
          if (match) {
            if (pattern.toString().includes('ноября')) {
              const months = {
                'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
                'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
                'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
              };
              const day = match[1].padStart(2, '0');
              const month = months[match[2].toLowerCase()];
              const year = match[3];
              return `${day}.${month}.${year}`;
            } else {
              const day = match[1].padStart(2, '0');
              const month = match[2].padStart(2, '0');
              const year = match[3];
              return `${day}.${month}.${year}`;
            }
          }
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
      })(),
      
      contractor: (() => {
        // Ищем контрагента по разным паттернам
        const patterns = [
          /ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ[^,\n]+/i,
          /ООО[^,\n]+/i,
          /"([^"]+)"/i,
          /[A-Z]{2,} [A-Z]{2,} [A-Z]{2,}/ // Для текста в верхнем регистре
        ];
        
        for (let pattern of patterns) {
          const match = decodedText.match(pattern);
          if (match) {
            let contractor = match[0].trim();
            // Пытаемся исправить кодировку для контрагента
            contractor = fixEncoding(contractor);
            console.log(`🏢 Найден контрагент: ${contractor}`);
            return contractor;
          }
        }
        return "";
      })(),
      
      amount: (() => {
        console.log('🔍 Начинаем поиск суммы...');
        
        // 1. Сначала из имени файла
        const filenameMatch = filename.match(/=\s*([\d.]+)/);
        if (filenameMatch) {
          console.log(`💰 Сумма из имени файла: ${filenameMatch[1]}`);
          return parseFloat(filenameMatch[1]);
        }
        
        // 2. Ищем суммы в формате 1 050.00 или 1,050.00
        const amountPatterns = [
          /(\d{1,3}(?:\s\d{3})*[.,]\d{2})/g,
          /(\d+[.,]\d{2})/g
        ];
        
        let allAmounts = [];
        for (let pattern of amountPatterns) {
          const matches = decodedText.match(pattern) || [];
          allAmounts = allAmounts.concat(matches);
        }
        
        if (allAmounts.length > 0) {
          // Преобразуем в числа и фильтруем валидные
          const amounts = allAmounts.map(amt => {
            const cleanAmt = amt.replace(/\s/g, '').replace(',', '.');
            return parseFloat(cleanAmt);
          }).filter(amt => !isNaN(amt) && amt > 0);
          
          if (amounts.length > 0) {
            // Берем максимальную сумму (скорее всего это итог)
            const maxAmount = Math.max(...amounts);
            console.log(`💰 Найдены суммы: ${amounts}, выбрана максимальная: ${maxAmount}`);
            return maxAmount;
          }
        }
        
        console.log('❌ Сумма не найдена');
        return 0;
      })(),
      
      incomingNumber: (() => {
        // Ищем номер в разных форматах
        const patterns = [
          /(\d{5,}\/\d{2,})/, // 2965673/12
          /(\d{6,})/, // длинные номера
          /Счет[^]*?(\d+\/\d+)/i,
          /фактура[^]*?(\d+\/\d+)/i
        ];
        
        for (let pattern of patterns) {
          const match = decodedText.match(pattern);
          if (match && match[1]) {
            const number = match[1].trim();
            console.log(`🔢 Найден номер: ${number}`);
            return number;
          }
        }
        
        console.log('❌ Номер не найден');
        return "не найден";
      })(),
      
      comment: (() => {
        // Ищем 4 цифры в конце строк или отдельно стоящие
        const patterns = [
          /(\d{4})/g,
          /0566/,
          /0566/
        ];
        
        for (let pattern of patterns) {
          const matches = decodedText.match(pattern);
          if (matches) {
            // Ищем 4-значные числа, которые скорее всего являются комментариями
            for (let match of matches) {
              if (match.length === 4 && /^\d{4}$/.test(match)) {
                console.log(`🏷️ Найден комментарий: ${match}`);
                return match;
              }
            }
          }
        }
        return "";
      })()
    };
    
    console.log('📊 Извлеченные данные:', extractedData);
    
    res.json({
      filename: filename,
      extractedData: extractedData
    });
  } catch (error) {
    console.error('Ошибка парсинга PDF:', error);
    res.status(500).json({ error: error.message });
  }
});

// Функция для исправления кодировки
function fixEncoding(text) {
  if (!text) return '';
  
  // Заменяем common encoding issues
  return text
    .replace(/OBLECTBO/g, 'ОБЩЕСТВО')
    .replace(/OrPAHWUEHHOM/g, 'ОГРАНИЧЕННОЙ')
    .replace(/OTBETCTBEHHOCTbIO/g, 'ОТВЕТСТВЕННОСТЬЮ')
    .replace(/mABOPVT/g, 'ФАВОРИТ')
    .replace(/OOO/g, 'ООО');
}

// Улучшенный рендер страницы для лучшего распознавания
function renderPage(pageData) {
  const renderOptions = {
    normalizeWhitespace: false,
    disableCombineTextItems: false
  };
  
  return pageData.getTextContent(renderOptions)
    .then(textContent => {
      let lastY, text = '';
      for (let item of textContent.items) {
        if (lastY !== item.transform[5]) {
          lastY = item.transform[5];
          text += '\n';
        }
        text += item.str + ' ';
      }
      return text;
    });
}

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});