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
    const extractedData = {
      date: (() => {
        // Ищем дату в формате "16 ноября 2025 г." и конвертируем в "16.11.2025"
        const match = data.text.match(/(\d{1,2})\s+(ноября|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/i);
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
        const dateMatch = data.text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
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
      })(),
      
      contractor: (() => {
        // Ищем продавца/поставщика в разных вариантах
        const patterns = [
          /Продавец\s+([^\n]+)/i,
          /Поставщик\s+([^\n]+)/i,
          /ООО[^,\n]+/i,
          /АО[^,\n]+/i,
          /ПАО[^,\n]+/i,
          /ИП[^,\n]+/i,
          /"([^"]+)"/i
        ];
        
        for (let pattern of patterns) {
          const match = data.text.match(pattern);
          if (match) {
            const contractor = match[1] ? match[1].trim() : match[0].trim();
            if (contractor.length > 5) {
              console.log(`🏢 Найден контрагент: ${contractor}`);
              return contractor;
            }
          }
        }
        return "";
      })(),
      
      amount: (() => {
        console.log('🔍 Поиск итоговой суммы в таблице...');
        
        const lines = data.text.split('\n');
        let tableRows = [];
        
        // Собираем все строки, которые выглядят как строки таблицы с суммами
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          
          // Ищем строки с паттерном чисел через пробелы (как в таблице)
          if (line.match(/\d+[.,]\d{2}\s+\D+\s+\d+%\s+\d+[.,]\d{2}\s+\d+[.,]\d{2}/) ||
              line.match(/(\d+[.,]\d{2}\s+){2,}\d+[.,]\d{2}/)) {
            console.log('📊 Найдена строка таблицы:', line);
            tableRows.push(line);
          }
        }
        
        // Если нашли строки таблицы, берем ПОСЛЕДНЮЮ строку и последнее число в ней
        if (tableRows.length > 0) {
          const lastRow = tableRows[tableRows.length - 1];
          console.log('🎯 Последняя строка таблицы:', lastRow);
          
          // Ищем все числа в этой строке
          const numbers = lastRow.match(/(\d+[.,]\d{2})/g);
          if (numbers && numbers.length > 0) {
            // Берем ПОСЛЕДНЕЕ число в строке - это "Стоимость с налогом - всего"
            const lastNumber = numbers[numbers.length - 1];
            const amount = parseFloat(lastNumber.replace(',', '.'));
            
            if (!isNaN(amount)) {
              console.log(`💰 ИТОГОВАЯ СУММА: ${amount}`);
              return amount;
            }
          }
        }
        
        console.log('❌ Итоговая сумма не найдена в таблице');
        return 0;
      })(),
      
      incomingNumber: (() => {
        // Ищем номер счета-фактуры в разных форматах
        const patterns = [
          /Счет-фактура\s+No?\s*(\d+\/\d+)/i,
          /Счет-фактура\s+No?\s*(\d+)/i,
          /Счет-фактура\s+№\s*(\d+\/\d+)/i,
          /Счет-фактура\s+№\s*(\d+)/i,
          /№\s*(\d+\/\d+)\s+от/i,
          /№\s*(\d+)\s+от/i,
          /(\d{5,}\/\d{2,})/i,
          /(\d{6,})/i,
          /Счет-фактура[^]*?(\d+\/\d+)/i,
          /Счет-фактура[^]*?(\d+)/i
        ];
        
        for (let pattern of patterns) {
          const match = data.text.match(pattern);
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
        // Ищем комментарий в разных вариантах написания
        const patterns = [
          /Счет-Оферта\s+No\s*(\d+)-(\d+)/i,
          /Счет-Оферта\s+№\s*(\d+)-(\d+)/i,
          /Счет-Оферта[^]*?(\d{4})/i
        ];
        
        for (let pattern of patterns) {
          const match = data.text.match(pattern);
          if (match) {
            // Возвращаем последние 4 цифры (0566)
            if (match[2]) return match[2];
            if (match[1] && match[1].length >= 4) return match[1].slice(-4);
            if (match[1]) return match[1];
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