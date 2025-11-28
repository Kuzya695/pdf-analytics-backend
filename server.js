const express = require('express');
const cors = require('cors');
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const pdfParse = require('pdf-parse');
const app = express();

app.use(cors());
app.use(express.json());

const s3 = new S3Client({
  endpoint: 'https://storage.yandexcloud.net',
  region: 'ru-central1',
  credentials: {
    accessKeyId: process.env.YANDEX_ACCESS_KEY,
    secretAccessKey: process.env.YANDEX_SECRET_KEY
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'PDF Analytics Backend работает!' });
});

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

app.get('/api/parse/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    const pdfData = await s3.send(new GetObjectCommand({
      Bucket: 'faktura35',
      Key: `С-фактура(PDF)/${filename}`
    }));
    
    const chunks = [];
    for await (const chunk of pdfData.Body) {
      chunks.push(chunk);
    }
    const pdfBuffer = Buffer.concat(chunks);
    
    const data = await pdfParse(pdfBuffer);
    
    console.log('=== ВЕСЬ ТЕКСТ PDF ===');
    console.log(data.text);
    console.log('=== КОНЕЦ ТЕКСТА PDF ===');
    
    const extractedData = {
      date: (() => {
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
        
        const dateMatch = data.text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (dateMatch) {
          const day = dateMatch[1].padStart(2, '0');
          const month = dateMatch[2].padStart(2, '0');
          const year = dateMatch[3];
          return `${day}.${month}.${year}`;
        }
        
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
        console.log('🔍 Умный поиск итоговой суммы с НДС...');
        const lines = data.text.split('\n');
        
        // Ищем блок с итоговыми суммами после товаров
        let foundGoodsSection = false;
        let goodsCount = 0;
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          
          // Считаем товары (строки с ценами)
          if (line.match(/\d+[.,]\d{2}.*\d+[.,]\d{2}.*\d+[.,]\d{2}/)) {
            goodsCount++;
            foundGoodsSection = true;
            console.log(`📦 Товар ${goodsCount}: ${line}`);
          }
          
          // После товаров ищем итоговую строку
          if (foundGoodsSection && goodsCount >= 2 && line.includes('Всего к оплате')) {
            console.log('🎯 Найдена итоговая строка:', line);
            
            // Ищем суммы в следующих 5 строках
            for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
              const numbers = lines[j].match(/(\d+[.,]\d{2})/g);
              if (numbers && numbers.length >= 3) {
                // В итоговой строке обычно 3 суммы: без НДС, НДС, с НДС
                // Нам нужна последняя (292.00)
                const finalAmount = parseFloat(numbers[numbers.length - 1].replace(',', '.'));
                if (!isNaN(finalAmount) && finalAmount > 100) {
                  console.log(`💰 Итоговая сумма с НДС: ${finalAmount}`);
                  return finalAmount;
                }
              }
            }
          }
        }
        
        // Если не нашли по структуре, ищем самую большую разумную сумму
        console.log('🔍 Резервный поиск самой большой суммы...');
        const allNumbers = data.text.match(/(\d+[.,]\d{2})/g) || [];
        const amounts = allNumbers.map(num => parseFloat(num.replace(',', '.')))
                                 .filter(amount => amount > 50 && amount < 10000); // Фильтр разумных сумм
        if (amounts.length > 0) {
          const maxAmount = Math.max(...amounts);
          console.log(`💰 Самая большая разумная сумма: ${maxAmount}`);
          return maxAmount;
        }
        
        console.log('❌ Сумма не найдена');
        return 0;
      })(),
      
      incomingNumber: (() => {
        const patterns = [
          /Счет-фактура\s+No?\s*(\d+\/\d+)/i,
          /Счет-фактура\s+No?\s*(\d+)/i,
          /Счет-фактура\s+№\s*(\d+\/\d+)/i,
          /Счет-фактура\s+№\s*(\d+)/i,
          /№\s*(\d+\/\d+)\s+от/i,
          /№\s*(\d+)\s+от/i,
          /(\d{5,}\/\d{2,})/i,
          /(\d{6,})/i
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
        const patterns = [
          /Счет-Оферта\s+No\s*(\d+)-(\d+)/i,
          /Счет-Оферта\s+№\s*(\d+)-(\d+)/i,
          /Счет-Оферта[^]*?(\d{4})/i
        ];
        
        for (let pattern of patterns) {
          const match = data.text.match(pattern);
          if (match) {
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

app.get('/api/download/:filename', async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const directUrl = `https://storage.yandexcloud.net/faktura35/С-фактура(PDF)/${encodeURIComponent(filename)}`;
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