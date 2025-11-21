// Функция для скачивания отсортированных PDF
async function downloadSortedPDFs() {
    if (!isAuthenticated) return;
    
    if (allInvoices.length === 0) {
        alert('Нет данных для создания архива');
        return;
    }
    
    try {
        // Показываем прогресс-бар
        showProgress();
        updateProgress(0, 'Подготовка файлов...', 'Начинаем создание архива', '0/0', '0');
        
        // Создаем ZIP архив
        const zip = new JSZip();
        
        // Группируем файлы по комментариям
        const groupedByComment = {};
        let totalFiles = 0;
        
        allInvoices.forEach(invoice => {
            const comment = invoice.comment || 'Без_комментария';
            const filename = invoice.filename;
            
            if (!groupedByComment[comment]) {
                groupedByComment[comment] = [];
            }
            groupedByComment[comment].push(filename);
            totalFiles++;
        });
        
        updateProgress(5, 'Группировка файлов...', `Найдено ${totalFiles} файлов в ${Object.keys(groupedByComment).length} категориях`, `0/${totalFiles}`, '0');
        
        // Создаем массив промисов для скачивания файлов
        const downloadPromises = [];
        let processedFiles = 0;
        let totalSize = 0;
        
        for (const [comment, filenames] of Object.entries(groupedByComment)) {
            // Создаем папку для комментария (заменяем запрещенные символы)
            const folderName = comment.replace(/[<>:"/\\|?*]/g, '_');
            const folder = zip.folder(folderName);
            
            for (const filename of filenames) {
                // Создаем промис для каждого файла
                const promise = (async (currentFilename, currentFolder) => {
                    try {
                        const currentFileNumber = processedFiles + 1;
                        
                        // Обновляем прогресс перед скачиванием
                        updateProgress(
                            5 + (currentFileNumber / totalFiles) * 85,
                            `Скачивание файлов...`,
                            `Файл: ${currentFilename}`,
                            `${currentFileNumber}/${totalFiles}`,
                            (totalSize / (1024 * 1024)).toFixed(2)
                        );
                        
                        console.log(`Начинаю скачивание: ${currentFilename}`);
                        
                        // Скачиваем PDF файл
                        const response = await fetch(`${API_BASE}/api/download/${encodeURIComponent(currentFilename)}`);
                        
                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                        }
                        
                        const blob = await response.blob();
                        
                        // Проверяем что файл не пустой
                        if (blob.size === 0) {
                            throw new Error('Файл пустой');
                        }
                        
                        // Добавляем файл в папку архива
                        currentFolder.file(currentFilename, blob);
                        processedFiles++;
                        totalSize += blob.size;
                        
                        console.log(`✅ Файл ${currentFilename} успешно добавлен в архив (${(blob.size / 1024).toFixed(1)} KB)`);
                        return { success: true, filename: currentFilename, size: blob.size };
                        
                    } catch (error) {
                        console.error(`❌ Ошибка скачивания ${currentFilename}:`, error);
                        processedFiles++;
                        return { success: false, filename: currentFilename, error: error.message };
                    }
                })(filename, folder);
                
                downloadPromises.push(promise);
                
                // Небольшая задержка чтобы не перегружать API (100ms между запросами)
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        // Ждем завершения всех скачиваний
        updateProgress(90, 'Обработка файлов...', 'Ожидаем завершения загрузки...', `${processedFiles}/${totalFiles}`, (totalSize / (1024 * 1024)).toFixed(2));
        
        console.log(`Ожидаем завершения ${downloadPromises.length} промисов...`);
        const results = await Promise.all(downloadPromises);
        
        // Проверяем результаты
        const successfulDownloads = results.filter(r => r.success).length;
        const failedDownloads = results.filter(r => !r.success).length;
        
        console.log(`📊 Итоги скачивания: Успешно: ${successfulDownloads}, Ошибок: ${failedDownloads}`);
        
        // Выводим детальную информацию об ошибках
        if (failedDownloads > 0) {
            const failedFiles = results.filter(r => !r.success).map(r => `${r.filename}: ${r.error}`);
            console.log('❌ Ошибки скачивания:', failedFiles);
        }
        
        if (successfulDownloads === 0) {
            hideProgress();
            alert('❌ Не удалось скачать ни одного файла. Проверьте:\n1. Доступность сервера\n2. Наличие эндпоинта /api/download/\n3. Консоль браузера для деталей ошибок');
            return;
        }
        
        // Генерируем архив
        updateProgress(95, 'Создание архива...', 'Формируем ZIP файл', `${successfulDownloads}/${totalFiles}`, (totalSize / (1024 * 1024)).toFixed(2));
        
        console.log('Начинаем генерацию ZIP архива...');
        const content = await zip.generateAsync({ 
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });
        
        // Скачиваем архив
        updateProgress(100, 'Завершено!', 'Архив готов к скачиванию', `${successfulDownloads}/${totalFiles}`, (content.size / (1024 * 1024)).toFixed(2));
        
        const currentDate = new Date().toISOString().split('T')[0];
        const archiveName = `счета-фактуры_по-комментариям_${currentDate}.zip`;
        
        console.log(`Скачиваем архив: ${archiveName}, размер: ${(content.size / 1024 / 1024).toFixed(2)} MB`);
        saveAs(content, archiveName);
        
        // Показываем итоговое сообщение
        setTimeout(() => {
            hideProgress();
            if (failedDownloads > 0) {
                alert(`✅ Архив создан! Успешно: ${successfulDownloads} файлов, Ошибок: ${failedDownloads}\n\nПроверьте консоль браузера для деталей ошибок.`);
            } else {
                alert(`✅ Архив успешно создан! Все ${successfulDownloads} файлов добавлены.\nРазмер архива: ${(content.size / 1024 / 1024).toFixed(2)} MB`);
            }
        }, 1000);
        
    } catch (error) {
        console.error('❌ Критическая ошибка при создании архива:', error);
        hideProgress();
        alert('❌ Ошибка при создании архива: ' + error.message + '\n\nПроверьте консоль браузера для деталей.');
    }
}