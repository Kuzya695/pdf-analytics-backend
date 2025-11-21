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

// УЛУЧШЕННОЕ извлечение суммы
function extractAmount(text, filename) {
  console.log('🔍 Начинаем поиск суммы...');
  
  // 1. Сначала ищем в названии файла
  const filenameMatch = filename.match(/=\s*([\d.]+)/);
  if (filenameMatch) {
    const amount = parseFloat(filenameMatch[1]);
    console.log(`💰 Сумма из имени файла: ${amount}`);
    return amount;
  }
  
  // 2. Улучшенный поиск по таблице - ищем конкретные паттерны цен
  console.log('📋 Ищем суммы в таблице товаров...');
  
  // Паттерны для поиска сумм в разных форматах
  const amountPatterns = [
    /(\d{1,3}(?:\s\d{3})*[.,]\d{2})/g, // 1 050.00 или 1,050.00
    /(\d+[.,]\d{2})/g, // 1050.00
    /(\d+(?:\s\d{3})*)/g // 1050 или 1 050
  ];
  
  // Разбиваем текст на строки для анализа таблицы
  const lines = text.split('\n');
  
  // Ищем строки с товарами - они содержат единицы измерения и цены
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Признаки строки с товаром в таблице
    const isProductLine = 
      (line.includes('шт') || line.includes('ШТ') || 
       line.includes('кг') || line.includes('КГ') ||
       line.includes('уп') || line.includes('УП') ||
       line.includes('ед') || line.includes('ЕД')) &&
      (line.match(/\d+[.,]\d{2}/) || line.match(/\d{1,3}\s\d{3}/));
    
    if (isProductLine) {
      console.log(`🎯 Найдена строка товара: "${line}"`);
      
      // Извлекаем все числа из строки
      const numbers = [];
      
      // Ищем суммы во всех форматах
      amountPatterns.forEach(pattern => {
        const matches = line.match(pattern);
        if (matches) {
          matches.forEach(match => {
            // Конвертируем в число
            const cleanNumber = match.replace(/\s/g, '').replace(',', '.');
            const num = parseFloat(cleanNumber);
            if (!isNaN(num) && num > 0 && num < 1000000) { // Реалистичные пределы
              numbers.push(num);
            }
          });
        }
      });
      
      console.log(`📊 Найдены числа в строке:`, numbers);
      
      // Логика выбора правильной суммы:
      if (numbers.length >= 2) {
        // В таблице обычно: цена | количество | стоимость
        // Стоимость = цена × количество
        // Ищем пару чисел, где одно делится на другое без остатка
        for (let j = 0; j < numbers.length; j++) {
          for (let k = j + 1; k < numbers.length; k++) {
            const larger = Math.max(numbers[j], numbers[k]);
            const smaller = Math.min(numbers[j], numbers[k]);
            
            // Если большее число делится на меньшее без остатка (или с небольшим округлением)
            if (smaller > 0 && larger % smaller < 0.01) {
              const quantity = larger / smaller;
              // Если количество - целое число (обычно 1, 2, 10 и т.д.)
              if (Math.abs(quantity - Math.round(quantity)) < 0.01) {
                console.log(`💰 Найдена стоимость товара: ${larger} (цена: ${smaller} × количество: ${quantity})`);
                return larger;
              }
            }
          }
        }
        
        // Если не нашли пару, берем наибольшее число (скорее всего итоговая стоимость)
        const maxAmount = Math.max(...numbers);
        console.log(`💰 Берем максимальную сумму: ${maxAmount}`);
        return maxAmount;
      } else if (numbers.length === 1) {
        console.log(`💰 Единственная сумма: ${numbers[0]}`);
        return numbers[0];
      }
    }
  }
  
  // 3. Поиск итоговых сумм в документе
  console.log('🔍 Ищем итоговые суммы...');
  
  const totalPatterns = [
    /Всего к оплате[\s\S]*?([\d\s.,]+)\s*₽/i,
    /Стоимость товаров[^]*?с налогом[^]*?([\d\s.,]+)/i,
    /Стоимость с налогом[\s\S]*?([\d\s.,]+)/i,
    /Всего[\s\S]*?([\d\s.,]+)\s*₽/i,
    /Итого[\s\S]*?([\d\s.,]+)\s*₽/i,
    /К оплате[\s\S]*?([\d\s.,]+)\s*₽/i
  ];
  
  for (let pattern of totalPatterns) {
    const match = text.match(pattern);
    if (match) {
      const amountStr = match[1].replace(/\s/g, '').replace(',', '.');
      const amount = parseFloat(amountStr);
      if (!isNaN(amount) && amount > 0) {
        console.log(`💰 Найдена итоговая сумма по паттерну: ${amount}`);
        return amount;
      }
    }
  }
  
  // 4. Поиск всех сумм в тексте и берем максимальную реалистичную
  console.log('🔍 Ищем все суммы в тексте...');
  
  const allAmounts = [];
  amountPatterns.forEach(pattern => {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(match => {
        const cleanNumber = match.replace(/\s/g, '').replace(',', '.');
        const num = parseFloat(cleanNumber);
        if (!isNaN(num) && num > 10 && num < 1000000) { // Реалистичные пределы для счета-фактуры
          allAmounts.push(num);
        }
      });
    }
  });
  
  if (allAmounts.length > 0) {
    const maxAmount = Math.max(...allAmounts);
    console.log(`💰 Максимальная сумма в документе: ${maxAmount}`);
    return maxAmount;
  }
  
  console.log('❌ Сумма не найдена');
  return 0;
}

// Улучшенное извлечение даты
function extractDate(text, filename) {
  const datePatterns = [
    // Формат "17.11.2025"
    /(\d{1,2})\.(\d{1,2})\.(\d{4})/,
    // Формат "16 ноября 2025 г."
    /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/i,
    // Формат "16 ноября 2025"
    /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})(?:\s*г\.)?/i
  ];
  
  for (let pattern of datePatterns) {
    const match = text.match(pattern);
    if (match) {
      if (pattern.toString().includes('мая|июня|июля')) {
        // Для текстовых месяцев
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
        // Для числового формата
        const day = match[1].padStart(2, '0');
        const month = match[2].padStart(2, '0');
        const year = match[3];
        return `${day}.${month}.${year}`;
      }
    }
  }
  
  // Если не нашли, пробуем из имени файла
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
  const patterns = [
    /Продавец\s*[:\-\n]*\s*([^\n]+?)(?:\n|$)/i,
    /Поставщик\s*[:\-\n]*\s*([^\n]+?)(?:\n|$)/i,
    /ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ[^,\n]*"([^"]+)"/i,
    /ООО[^,\n]*"([^"]+)"/i,
    /"([^"]+)"\s*ООО/i,
    /([А-ЯЁ][а-яё]+\s*"([^"]+)"|\b(?:ООО|АО|ПАО|ИП)\s+[^,\n]+)/i
  ];
  
  for (let pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let contractor = match[1] ? match[1].trim() : match[0].trim();
      // Очищаем от лишних пробелов и переносов
      contractor = contractor.replace(/\s+/g, ' ').replace(/\n/g, ' ');
      if (contractor.length > 3) {
        console.log(`🏢 Найден контрагент: ${contractor}`);
        return contractor;
      }
    }
  }
  return "";
}

// Улучшенное извлечение номера счета-фактуры
function extractInvoiceNumber(text) {
  const patterns = [
    /Счет-фактура\s+[№N]?\s*(\d+\/\d+)/i,
    /Счет-фактура\s+[№N]?\s*(\d+)/i,
    /[№N]\s*(\d+\/\d+)\s+от/i,
    /[№N]\s*(\d+)\s+от/i,
    /(\d{5,}\/\d{2,})/,
    /Счет-фактура[^]*?(\d+\/\d+)/i
  ];
  
  for (let pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const number = match[1].trim();
      console.log(`🔢 Найден номер: ${number}`);
      return number;
    }
  }
  return "не найден";
}

// Улучшенное извлечение комментария
function extractComment(text, filename) {
  const patterns = [
    /Счет-Оферта\s+[№N]?\s*\d+-(\d+)/i,
    /Счет-Оферта\s+[№N]?\s*(\d+)/i,
    /Оферта\s+[№N]?\s*\d+-(\d+)/i,
    /(\d{4})\s*$/m, // 4 цифры в конце строки
    /\b(\d{4})\b/ // Любые 4 цифры
  ];
  
  for (let pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const comment = match[1] || match[0];
      if (comment.length === 4 && !isNaN(comment)) {
        console.log(`🏷️ Найден комментарий: ${comment}`);
        return comment;
      }
    }
  }
  
  // Пробуем из имени файла
  const filenameMatch = filename.match(/(\d{4})/);
  if (filenameMatch) {
    console.log(`🏷️ Комментарий из имени файла: ${filenameMatch[1]}`);
    return filenameMatch[1];
  }
  
  return "";
}

// Улучшенный рендерер текста
function textRenderer(pageData) {
  return pageData.getTextContent().then(function(textContent) {
    let lastY, text = '';
    for (let item of textContent.items) {
      if (lastY == item.transform[5] || !lastY) {
        text += item.str;
      } else {
        text += '\n' + item.str;
      }
      lastY = item.transform[5];
    }
    return text;
  });
}

// Улучшенная функция извлечения данных
function extractInvoiceData(text, filename) {
  const data = {
    date: extractDate(text, filename),
    contractor: extractContractor(text),
    amount: extractAmount(text, filename),
    incomingNumber: extractInvoiceNumber(text),
    comment: extractComment(text, filename)
  };
  
  return data;
}

// Парсинг конкретного PDF файла - УЛУЧШЕННАЯ ВЕРСИЯ
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
    
    // Парсим PDF с улучшенными настройками
    const data = await pdfParse(pdfBuffer, {
      pagerender: textRenderer,
      max: 0 // Обрабатываем все страницы
    });
    
    console.log('📄 Текст PDF:', data.text.substring(0, 500) + '...');
    
    // Извлекаем данные из текста
    const extractedData = extractInvoiceData(data.text, filename);
    
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