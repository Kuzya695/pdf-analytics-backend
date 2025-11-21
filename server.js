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
        // Ищем дату в формате "16 ноября 2025 г." или "17 ноября 2025 г." и конвертируем в "16.11.2025"
        // Учитываем возможные знаки препинания после месяца
        const match = data.text.match(/(\d{1,2})\s+(ноября|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)[\s.,]*\s*(\d{4})/i);
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
        // Пытаемся исключить строки, содержащие "Покупатель", "Грузоотправитель", "Грузополучатель"
        const lines = data.text.split('\n');
        for (const line of lines) {
          // Пропускаем строки, которые явно не являются поставщиком
          if (line.match(/(Покупатель|Грузоотправитель|Грузополучатель)/i)) {
            continue;
          }
          // Ищем строки с "Продавец", "Поставщик"
          const sellerMatch = line.match(/^(Продавец|Поставщик):\s*(.+)/i);
          if (sellerMatch) {
            const contractor = sellerMatch[2].trim();
            if (contractor.length > 5) {
              console.log(`🏢 Найден контрагент (Продавец/Поставщик): ${contractor}`);
              return contractor;
            }
          }
          // Ищем строки с "ООО", "АО", "ПАО", "ИП" - потенциальные поставщики
          const legalEntityMatch = line.match(/^(ООО|АО|ПАО|ИП)\s+([^,;]+)/i);
          if (legalEntityMatch) {
            const contractor = `${legalEntityMatch[1]} ${legalEntityMatch[2]}`.trim();
            if (contractor.length > 5) {
              console.log(`🏢 Найден контрагент (Организация): ${contractor}`);
              return contractor;
            }
          }
        }

        // Если не нашли в структурированном виде, ищем в тексте по паттернам
        const patterns = [
          /Продавец:\s*([^
]+)()/i,
          /Поставщик:\s*([^
]+)()/i,
          /Продавец\s+([^
]+)/i,
          /Поставщик\s+([^
]+)/i,
          /ООО[^,
;]+/i,
          /АО[^,
;]+/i,
          /ПАО[^,
;]+/i,
          /ИП[^,
;]+/i,
          /"([^"]{5,}?)"/i // Кавычки, но только если текст внутри длиннее 5 символов
        ];
        for (let pattern of patterns) {
          const match = data.text.match(pattern);
          if (match) {
            // Берем первую группу захвата, если она есть, иначе всю найденную строку
            const contractor = (match[1] ? match[1].trim() : match[0].trim()).replace(/^["']|["']$/g, '');
            if (contractor.length > 5 && !contractor.match(/(Покупатель|Грузоотправитель|Грузополучатель)/i)) {
              console.log(`🏢 Найден контрагент (паттерн): ${contractor}`);
              return contractor;
            }
          }
        }
        return "не найден";
      })(),
      amount: (() => {
        console.log('🔍 Начинаем поиск суммы...');
        // 1. Сначала из имени файла
        const filenameMatch = filename.match(/=\s*([\d.]+)/);
        if (filenameMatch) {
          console.log(`💰 Сумма из имени файла: ${filenameMatch[1]}`);
          return parseFloat(filenameMatch[1]);
        }
        // 2. Ищем итоговые суммы в разных вариантах
        const totalPatterns = [
          /Всего к оплате[\s\S]*?([\d\s.,]+)\s*₽/i,
          /Стоимость товаров[^]*?с налогом[^]*?([\d\s.,]+)/i,
          /Стоимость с налогом[\s\S]*?([\d\s.,]+)/i,
          /Всего[\s\S]*?([\d\s.,]+)\s*₽/i,
          /Итого[\s\S]*?([\d\s.,]+)\s*₽/i
        ];
        for (let pattern of totalPatterns) {
          const match = data.text.match(pattern);
          if (match) {
            const amountStr = match[1].replace(/\s/g, '').replace(',', '.');
            const amount = parseFloat(amountStr);
            if (!isNaN(amount) && amount > 0) {
              console.log(`💰 Найдена сумма по паттерну "${pattern}": ${amount}`);
              return amount;
            }
          }
        }
        // 3. Ищем суммы в таблице - берем последнюю колонку последней строки
        const lines = data.text.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          // Ищем суммы в формате 1 050.00 или 1,050.00
          const amountMatches = line.match(/(\d{1,3}(?:\s\d{3})*[.,]\d{2})/g);
          if (amountMatches && amountMatches.length > 0) {
            // Берем последнюю сумму в строке (скорее всего итоговая)
            const lastAmount = amountMatches[amountMatches.length - 1];
            const amount = parseFloat(lastAmount.replace(/\s/g, '').replace(',', '.'));
            if (!isNaN(amount) && amount > 0) {
              console.log(`💰 Найдена сумма в таблице: ${amount}`);
              return amount;
            }
          }
        }
        // 4. Ищем все суммы в тексте и берем максимальную
        const allAmounts = data.text.match(/(\d{1,3}(?:\s\d{3})*[.,]\d{2})/g) || [];
        if (allAmounts.length > 0) {
          const amounts = allAmounts.map(amt =>
            parseFloat(amt.replace(/\s/g, '').replace(',', '.'))
          ).filter(amt => !isNaN(amt) && amt > 0);
          if (amounts.length > 0) {
            const maxAmount = Math.max(...amounts);
            console.log(`💰 Найдена максимальная сумма в тексте: ${maxAmount}`);
            return maxAmount;
          }
        }
        console.log('❌ Сумма не найдена');
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
        return "не задан";
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

module.exports = app;