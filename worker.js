// --- Динамическая сборка ссылок под любой город ---
function getApiEndpoints(env) {

    let URLS = `https://rating-api.quizplease.ru/api/external/team?city=${env.CITY_SLUG}`;

    return {
        "🏆 Сезонный рейтинг (Кино и музыка)": `${URLS}&rating=2&bySeason=true`,
        "🌍 Общий рейтинг (Кино и музыка)": `${URLS}&rating=2&bySeason=false`,
        "🌍 Общий рейтинг (Классика)": `${URLS}&rating=1&bySeason=false`,
        "🏆 Сезонный рейтинг (Классика)": `${URLS}&rating=1&bySeason=true`
    };
}

function getScheduleApi(env) {
    return `https://api.quizplease.ru/api/games/schedule/${env.CITY_ID}?order=date&meta[]=places_ids&meta[]=dates&statuses[]=0&statuses[]=1&statuses[]=2&statuses[]=3&statuses[]=5`;
}

const DAYS_OF_WEEK = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

export default {
    
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(runDailyCronTasks(env, controller));
    },

    async fetch(request, env, ctx) {

        // Cloudflare принимает только POST запросы от Telegram
        if (request.method === "POST") {
            try {
                const payload = await request.json();
                
                // 1. Ловим клики в опросах
                if (payload.poll_answer) {
                    ctx.waitUntil(handlePollAnswer(payload.poll_answer, env));
                }

                // Проверяем, есть ли текстовое сообщение
                if (payload.message && payload.message.text) {
                    const chatId = payload.message.chat.id;
                    const text = payload.message.text;
                    
                     console.log(`Получен текст: "${text}" от чата: ${chatId}`);

                    if (text.startsWith("/stats")) ctx.waitUntil(sendStats(chatId, env));
                    if (text.startsWith("/nextgame")) ctx.waitUntil(sendNextGamesList(chatId, env));
                    if (text.startsWith("/poll")) ctx.waitUntil(handlePollCommand(chatId, payload.message, env));
                    if (text.startsWith("/remind")) ctx.waitUntil(forceTestReminder(chatId, env));
                    if (text.startsWith("/halloffame") || text.startsWith("/hof")) {
                        ctx.waitUntil(sendHallOfFame(chatId, env));
                    }

                    if (text.startsWith("/testresults")) {
                        ctx.waitUntil(checkLiveResults(chatId, env));
                    }
                }
            } catch (e) {
                console.error("Ошибка обработки:", e);
            }
        }
        
        // Всегда возвращаем Telegram статус 200 OK
        return new Response("OK", { status: 200 });
    }
};

async function runDailyCronTasks(env, event) {
    
    const now = new Date();
    const localTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Krasnoyarsk" }));
    const currentHour = localTime.getHours();

    // 1. Напоминания об играх отправляем строго один раз в день в 10:00 утра
    if (currentHour === 10) {
        await checkAndSendReminders(env.CHAT_ID, env);
    }
    
    // 2. Проверяем изменения в общем рейтинге (Зал славы) тоже в 10:00
    if (currentHour === 10) {
        await trackRatingChanges(env.CHAT_ID, env);
    }

    // +++ 3. А вот проверку результатов игр запускаем КАЖДЫЙ раз при срабатывании крона +++
    await checkLiveResults(env.CHAT_ID, env);
}

// Функция сбора данных из 4 API Квизплиз и отправки в Telegram
async function sendStats(targetChatId, env) {
    let messageText = `🍩 <b>Статистика команды «${env.TEAM_NAME}»</b>\n\n`;
    
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    };

    for (const [label, baseUrl] of Object.entries(getApiEndpoints(env))) {
        try {
            const fullUrl = `${baseUrl}&title=${encodeURIComponent(env.TEAM_NAME)}`;
            
            // Используем стандартный fetch, встроенный в Cloudflare
            const response = await fetch(fullUrl, { headers });
            
            if (response.status === 200) {
                const json_data = await response.json();
                const teamsList = json_data.result  || [];
                if (teamsList.length > 0) {
                    const team = teamsList[0]; 
                    const points = team.points !== undefined ? team.points : 0;
                    const games = team.games !== undefined ? team.games : 0;
                    
                    messageText += `<b>${label}</b>\n`;
                    messageText += `├ ✨ Очки: <code>${points}</code>\n`;
                    messageText += `└ 🎮 Игры: <code>${games}</code>\n\n`;
                } else {
                    messageText += `<b>${label}</b>\n└ ⚠️ Нет сыгранных игр в этом сезоне\n\n`;
                }
            } else {
                messageText += `<b>${label}</b>\n└ ❌ Ошибка сервера Квизплиз (${response.status})\n\n`;
            }
        } catch (error) {
            messageText += `<b>${label}</b>\n└ ❌ Не удалось получить данные\n\n`;
        }
    }

    await sendTelegramMessage(targetChatId, messageText, env);
}

// --- Функция вывода расписания всех игр (/nextgame) ---
async function sendNextGamesList(targetChatId, env) {
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    };

    try {
        const response = await fetch(getScheduleApi(env), { headers });
        if (response.status === 200) {
            const json_data = await response.json();
            const gamesList = json_data.data?.data || [];

            if (gamesList.length > 0) {
                // Сначала отправляем заголовок афиши
                await sendTelegramMessage(targetChatId, "📅 <b>Актуальные игры в расписании Квиз, плиз!:</b>", env);

                // Перебираем игры и каждую отправляем ОТДЕЛЬНЫМ сообщением
                 for (const game of gamesList) {
                    const title = game.title || "Без названия";
                    const placeTitle = game.place?.title || "Место уточняется";
                    const rawDate = game.date || ""; 
                    
                    let dayOfWeekString = "";
                    let gameDate = "Дата не указана";
                    let gameTime = "";

                    // Парсим дату и определяем день недели
                    if (rawDate) {
                        const dateParts = rawDate.split(" ");
                        gameDate = dateParts[0]; // Берем только DD.MM.YYYY
                        gameTime = dateParts[1] || ""; // Берем только HH:MM

                        const parts = gameDate.split("."); 
                        if (parts.length === 3) {
                            const day = parseInt(parts[0], 10);
                            const month = parseInt(parts[1], 10) - 1;
                            const year = parseInt(parts[2], 10);
                            const dateObj = new Date(year, month, day);
                            dayOfWeekString = DAYS_OF_WEEK[dateObj.getDay()];
                        }
                    }
                    
                    // Извлекаем ID игры из API
                    const gameId = game.id || "";

                    let singleGameText = `🎯 <b>${title}</b>\n`;
                    singleGameText += `🗓 Когда: ${gameDate} (${dayOfWeekString}) в ${gameTime}\n`;
                    singleGameText += `📍 Где: ${placeTitle}\n`;
                    // Добавляем ID в виде скрытого спецсимвола в самом конце (выглядит как пустая строка)
                    singleGameText += `<code style="display:none;">#id_${game.id}</code>`;

                    await sendTelegramMessage(targetChatId, singleGameText, env);
                }
            } else {
                await sendTelegramMessage(targetChatId, "📅 <b>Афиша игр:</b> На данный момент доступных игр нет.", env);
            }
        } else {
            await sendTelegramMessage(targetChatId, `❌ Ошибка API Квиз, плиз! (${response.status})`, env);
        }
    } catch (error) {
        await sendTelegramMessage(targetChatId, "❌ Произошла ошибка при загрузке афиши.", env);
    }

}

// --- Функция создания опроса командой /poll ---
async function handlePollCommand(chatId, originalMessage, env) {
    // Проверяем, сделан ли /poll как ответ (reply) на сообщение бота
    const replyToMessage = originalMessage.reply_to_message;
    
    if (!replyToMessage || !replyToMessage.text) {
        await sendTelegramMessage(chatId, "⚠️ Ответьте командой <code>/poll</code> на сообщение с нужной игрой!", env);
        return;
    }

    const sourceText = replyToMessage.text;
    
     // Новые точные регулярные выражения для разбора отдельного сообщения игры
    const titleMatch = sourceText.match(/🎯\s*(.*)\n🗓/);
    const dateMatch = sourceText.match(/🗓\s*Когда:\s*(.*)\n📍/);
    const placeMatch = sourceText.match(/📍\s*Где:\s*(.*)/);

    const title = titleMatch ? titleMatch[1].trim() : "Квиз, плиз!";
    const dateInfo = dateMatch ? dateMatch[1].trim() : "Дата не указана";
    const place = placeMatch ? placeMatch[1].trim() : "Место не указано";

    // Безопасно разделяем дату и время
    const gameDateOnly = sourceText.match(/\d{2}\.\d{2}\.\d{4}/)?.[0] || "09.06.2026";
    const gameTimeOnly = sourceText.match(/\d{2}:\d{2}/)?.[0] || "19:30";


    // Вытаскиваем ID игры из скрытой ссылки
    const idMatch = sourceText.match(/#id_([a-zA-Z0-9-]+)/);
    const gameId = idMatch ? idMatch[1] : "";
    
    // Собираем лаконичный вопрос для опроса (Telegram ограничивает длину вопроса в 300 символов)
    const pollQuestion = `Кто идет на Квиз?\n\n📝 ${title}\n📅 ${dateInfo}\n📍 ${place}`;

    // Отправляем опрос (sendPoll) по правилам Telegram API
    const pollUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendPoll`;
    const response = await fetch(pollUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            question: pollQuestion,
            options: JSON.stringify(["Иду", "Иду + 1", "Без меня"]),
            is_anonymous: false,               // Не анонимный опрос (видно кто как голосовал)
            allows_multiple_answers: false,    // Выбрать можно только один вариант
            type: "regular"                    // Обычный тип голосования (не викторина)
        })
    });
    console.log(`текст: ${sourceText}`);

    if (response.status === 200) {
        const resJson = await response.json();
        const pollId = resJson.result?.poll?.id; // Уникальный ID опроса Telegram

        if (pollId && env.QUIZ_DB) {
            // Сохраняем структуру игры в базу данных KV, привязывая её к ID опроса
            const gameObject = {
                gameId: gameId, // СВЕРХВАЖНО: Теперь ID игры надежно сохранен в базу опроса
                title: title,
                date: gameDateOnly,
                time: gameTimeOnly,
                place: place,
                voters: {}, // Сюда будем записывать имена проголосовавших
                resultsChecked: false // Флаг, чтобы бот знал, что результаты этой игры еще не выводились
            };
            await env.QUIZ_DB.put(`poll:${pollId}`, JSON.stringify(gameObject));
            await env.QUIZ_DB.put(`date:${gameDateOnly}`, pollId); // Индекс для быстрого поиска по дате

            // Запоминаем ID игры отдельно для периодической проверки результатов
            if (gameId) {
                await env.QUIZ_DB.put(`active_game:${gameId}`, JSON.stringify({ pollId: pollId, date: gameDateOnly, time: gameTimeOnly }));
            }
        }
    }
}

// --- Функция отслеживания кликов на кнопки опроса ---
async function handlePollAnswer(pollAnswer, env) {
    if (!env.QUIZ_DB) return;

    const pollId = pollAnswer.poll_id;
    const userId = pollAnswer.user.id;
    const firstName = pollAnswer.user.first_name || "Игрок";
    const optionIds = pollAnswer.option_ids || [];

    const data = await env.QUIZ_DB.get(`poll:${pollId}`);
    if (!data) return;

    let gameObject = JSON.parse(data);

    if (optionIds.length === 0) {
        // Участник отменил свой голос
        delete gameObject.voters[userId];
    } else {
        // ИСПРАВЛЕНО: Извлекаем первый элемент из массива индексов ответов
        const choice = optionIds[0]; 
        let statusText = "";
        let count = 0;

        if (choice === 0) { statusText = "Иду"; count = 1; }
        if (choice === 1) { statusText = "Иду + 1"; count = 2; }
        if (choice === 2) { statusText = "Без меня"; count = 0; }

        gameObject.voters[userId] = { name: firstName, status: statusText, count: count };
    }

    await env.QUIZ_DB.put(`poll:${pollId}`, JSON.stringify(gameObject));
}

// --- Функция автоматического напоминания в 10:00 ---
async function checkAndSendReminders(targetChatId, env) {
    if (!env || !env.QUIZ_DB) {
        console.log("Критическая ошибка: База КV не найдена в функции напоминаний.");
        return;
    }

    try {
        // Получаем текущее локальное время в Новокузнецке (Красноярск +7)
        const now = new Date();
        const localTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Krasnoyarsk" }));
        
        const todayStr = formatDate(localTime);
        
        const tomorrowTime = new Date(localTime);
        tomorrowTime.setDate(tomorrowTime.getDate() + 1);
        const tomorrowStr = formatDate(tomorrowTime);

        console.log(`Проверка дат расписания. Сегодня: ${todayStr}, Завтра: ${tomorrowStr}`);

        // Проверяем, лежат ли в базе ключи для этих дат
        const todayPollId = await env.QUIZ_DB.get(`date:${todayStr}`);
        const tomorrowPollId = await env.QUIZ_DB.get(`date:${tomorrowStr}`);

        console.log(`Результат поиска в KV -> Сегодняшний опрос: ${todayPollId}, Завтрашний опрос: ${tomorrowPollId}`);

        // Отправляем напоминания, если нашли ID опросов в базе
        if (todayPollId) {
            await processReminder(todayPollId, "СЕГОДНЯ", targetChatId, env);
        }
        
        if (tomorrowPollId) {
            await processReminder(tomorrowPollId, "ЗАВТРА", targetChatId, env);
        }

    } catch (error) {
        console.error("Произошел сбой внутри checkAndSendReminders:", error.message);
        // Бот подстрахует и пришлет ошибку в чат, чтобы вы знали, на какой строке сбой
        await sendTelegramMessage(targetChatId, `💥 Ошибка планировщика напоминаний:\n<code>${error.message}</code>`, env);
    }
}

// --- Сборка текста напоминания со списками людей ---
async function processReminder(pollId, dayText, targetChatId, env) {
    const data = await env.QUIZ_DB.get(`poll:${pollId}`);
    if (!data) return;

    const game = JSON.parse(data);
    let totalGamers = 0;
    let playersList = [];

    if (game.voters) {
        for (const user of Object.values(game.voters)) {
            if (user && user.count > 0) {
                totalGamers += user.count;
                playersList.push(`• <b>${user.name}</b> (${user.status})`);
            }
        }
    }

    let reminderText = `🚨 <b>НАПОМИНАНИЕ: Игра ${dayText}!</b> 🚨\n\n`;
    reminderText += `🎯 <b>${game.title}</b>\n`;
    reminderText += `📅 <b>Дата:</b> ${game.date} в ${game.time}\n`;
    reminderText += `📍 <b>Где:</b> ${game.place}\n\n`;
    reminderText += `📊 <b>Текущий сбор состава:</b> 🔥 <u>${totalGamers} чел.</u>\n`;
    
    if (playersList.length > 0) {
        reminderText += `\nСписок идущих:\n${playersList.join("\n")}\n`;
    } else {
        reminderText += `\n<i>Пока никто не отметился. Команда, активнее!</i>\n`;
    }

    reminderText += `\n👉 <i>Проголосуйте в закрепленном опросе, если еще не сделали этого!</i>`;

    await sendTelegramMessage(targetChatId, reminderText, env);
}

function formatDate(dateObj) {
    const day = String(dateObj.getDate()).padStart(2, '0');
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const year = dateObj.getFullYear();
    return `${day}.${month}.${year}`;
}

// --- Вспомогательная функция отправки сообщения в Telegram ---
async function sendTelegramMessage(chatId, text, env) {
    const telegramUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
    try {
        await fetch(telegramUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: "HTML"
            })
        });
    } catch (err) {
        console.error("Ошибка отправки в Telegram:", err);
    }
}

async function forceTestReminder(targetChatId, env) {
    await checkAndSendReminders(targetChatId, env);
}

// --- ФУНКЦИЯ ТРЕКИНГА И ДОСТИЖЕНИЙ ---
async function trackRatingChanges(targetChatId, env) {
    if (!env.QUIZ_DB) return;
    const headers = { "User-Agent": "Mozilla/5.0" };

    for (const [label, baseUrl] of Object.entries(getApiEndpoints(env))) {
        try {
            const fullUrl = `${baseUrl}&title=${encodeURIComponent(env.TEAM_NAME)}`;
            const response = await fetch(fullUrl, { headers });
            
            if (response.status === 200) {
                const json_data = await response.json();
                const teamsList = json_data.result || [];
                
                if (teamsList.length > 0) {
                    const team = teamsList[0];
                    const currentPoints = team.points !== undefined ? team.points : 0;
                    const currentGames = team.games !== undefined ? team.games : 0;
                    const currentRank = team.rank?.title || "Без ранга";

                    // Пытаемся достать из базы данных старые (вчерашние) результаты
                    const dbKey = `stats:${label}`;
                    const cachedData = await env.QUIZ_DB.get(dbKey);
                    
                    if (cachedData) {
                        const oldStats = JSON.parse(cachedData);
                        const oldPoints = oldStats.points || 0;
                        const oldGames = oldStats.games || 0;

                        // Если количество сыгранных игр увеличилось — вы играли!
                        if (currentGames > oldGames) {
                            const pointsDiff = (currentPoints - oldPoints).toFixed(1);
                            const gamesDiff = currentGames - oldGames;

                            let celebrationText = `🎉 <b>ЗАЛ СЛАВЫ: Новое достижение!</b> 🎉\n\n`;
                            celebrationText += `🍩 Пончики, обновились таблицы результатов на сайте Квиз, плиз!:\n\n`;
                            celebrationText += `<b>Категория:</b> ${label}\n`;
                            celebrationText += `📈 <b>Прирост очков:</b> <code>+${pointsDiff}</code> баллов!\n`;
                            celebrationText += `🎮 <b>Сыграно за раз:</b> <code>+${gamesDiff}</code> игр(ы)\n\n`;
                            celebrationText += `🌟 <b>Текущие общие итоги в этой лиге:</b>\n`;
                            celebrationText += `├ ✨ Сумма очков: <code>${currentPoints}</code>\n`;
                            celebrationText += `├ 🎮 Всего игр: <code>${currentGames}</code>\n`;
                            celebrationText += `└ 🎖 Наш текущий ранг: <b>${currentRank}</b>\n\n`;
                            celebrationText += `<i>🔥 Отличный результат, так держать! Вперед к новым вершинам!</i>`;

                            // Отправляем праздничное уведомление в группу
                            await sendTelegramMessage(targetChatId, celebrationText, env);
                        }
                    }

                    // Перезаписываем текущие актуальные данные в базу как новые «вчерашние» для следующего дня
                    const statsToCache = {
                        points: currentPoints,
                        games: currentGames,
                        rank: currentRank,
                        updatedAt: new Date().toISOString()
                    };
                    await env.QUIZ_DB.put(dbKey, JSON.stringify(statsToCache));
                }
            }
        } catch (error) {
            console.error(`Ошибка трекера в категории ${label}:`, error);
        }
    }
}

// --- КОМАНДА /halloffame ДЛЯ РУЧНОГО ПРОСМОТРА СОСТОЯНИЯ ТРЕКЕРА ---
async function sendHallOfFame(targetChatId, env) {
    if (!env.QUIZ_DB) {
        await sendTelegramMessage(targetChatId, "❌ База данных не подключена.", env);
        return;
    }

    // Читаем данные из базы по всем 4 категориям
    const statsClassicSeason = JSON.parse(await env.QUIZ_DB.get("stats:🏆 Сезонный рейтинг (Классика)") || "null");
    const statsClassicGlobal = JSON.parse(await env.QUIZ_DB.get("stats:🌍 Общий рейтинг (Классика)") || "null");
    const statsMusicSeason = JSON.parse(await env.QUIZ_DB.get("stats:🏆 Сезонный рейтинг (Кино и музыка)") || "null");
    const statsMusicGlobal = JSON.parse(await env.QUIZ_DB.get("stats:🌍 Общий рейтинг (Кино и музыка)") || "null");

    // Вспомогательная функция для сборки красивой строки очков/игр
    const formatRow = (stats) => {
        if (!stats || stats.games === 0) return "<code>Сыгранных игр нет</code>";
        return `✨ Очки: <code>${stats.points}</code> | 🎮 Игры: <code>${stats.games}</code>`;
    };

    // Вытаскиваем общие ранги (если данных нет, пишем "Без ранга")
    const rankClassic = statsClassicGlobal?.rank || statsClassicSeason?.rank || "Без ранга";
    const rankMusic = statsMusicGlobal?.rank || statsMusicSeason?.rank || "Без ранга";

    // Сборка красивого сообщения
    let messageText = `🏆 <b>Зал славы команды «${env.TEAM_NAME}»</b>\n\n`;

    // Блок 1. КЛАССИКА
    messageText += `🧠 <b>КЛАССИКА (Ранг: ${rankClassic})</b>\n`;
    messageText += `├ 🏆 Сезон: ${formatRow(statsClassicSeason)}\n`;
    messageText += `└ 🌍 Общий: ${formatRow(statsClassicGlobal)}\n\n`;

    // Блок 2. КИНО И МУЗЫКА
    messageText += `🎬 <b>КИНО И МУЗЫКА (Ранг: ${rankMusic})</b>\n`;
    messageText += `├ 🏆 Сезон: ${formatRow(statsMusicSeason)}\n`;
    messageText += `└ 🌍 Общий: ${formatRow(statsMusicGlobal)}\n\n`;

    messageText += `<i>🕒 Данные обновляются автоматически каждый день в 10:00.</i>`;

    await sendTelegramMessage(targetChatId, messageText, env);
}

// --- ПЕРИОДИЧЕСКАЯ ПРОВЕРКА РЕЗУЛЬТАТОВ ИГРЫ ---
async function checkLiveResults(targetChatId, env) {
    if (!env || !env.QUIZ_DB) return;
    const headers = { "User-Agent": "Mozilla/5.0" };

    try {
        // Получаем из базы список всех ключей активных игр
        const list = await env.QUIZ_DB.list({ prefix: "active_game:" });
        if (!list.keys || list.keys.length === 0) return; // Если активных игр нет, засыпаем
        
         // Получаем текущее точное время в Новокузнецке (Красноярск +7)
        const now = new Date();
        const localTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Krasnoyarsk" }));
        
        for (const keyObj of list.keys) {
            const gameId = keyObj.name.replace("active_game:", "");
            
            // Читаем сохраненные данные опроса, чтобы узнать дату и время проведения игры
            const pollData = await env.QUIZ_DB.get(keyObj.name);
            if (!pollData) continue;

            const parsedPoll = JSON.parse(pollData);
            // Извлекаем полные данные игры из базы опросов
            const fullGameObj = await env.QUIZ_DB.get(`poll:${parsedPoll.pollId}`);
            if (!fullGameObj) continue;

            const game = JSON.parse(fullGameObj);
            
            // Если дата или время не записались (старый опрос), проверяем по старинке
            if (!game.date || !game.time) {
                console.log(`[Check] Нет данных времени для игры ${gameId}, опрашиваю напрямую...`);
            } else {
                // Собираем полноценный объект даты и времени начала игры
                // game.date: "09.06.2026", game.time: "19:30"
                const dateParts = game.date.split(".");
                const timeParts = game.time.split(":");
                
                if (dateParts.length === 3 && timeParts.length === 2) {
                    const gameStartDateTime = new Date(
                        parseInt(dateParts[2], 10),     // Год
                        parseInt(dateParts[1], 10) - 1, // Месяц (в JS от 0)
                        parseInt(dateParts[0], 10),     // День
                        parseInt(timeParts[0], 10),     // Час
                        parseInt(timeParts[1], 10)      // Минуты
                    );

                    // Добавляем к времени начала игры 2 часа (время на проведение Квиза)
                    const resultsAvailableTime = new Date(gameStartDateTime.getTime() + (2 * 60 * 60 * 1000));

                    // Если текущее время в Новокузнецке МЕНЬШЕ, чем время окончания игры — пропускаем шаг
                    if (localTime < resultsAvailableTime) {
                        console.log(`[Skip] Результаты игры ${game.title} еще рано проверять. Игра начнется в ${game.time}, проверка доступна после ${resultsAvailableTime.toLocaleTimeString("ru-RU", {hour: '2-digit', minute:'2-digit'})}`);
                        continue; 
                    }
                }
            }

            // Запрашиваем официальное API результатов Квизплиз по ID игры
            const resultsUrl = `https://api.quizplease.ru/api/games/${gameId}/results`;
            const response = await fetch(resultsUrl, { headers });
            
            if (response.status !== 200) continue;

            const json_data = await response.json();
            
            // Защита: Проверяем сообщение "Игра не найдена"
            if (json_data.data && json_data.data.message === "Игра не найдена") {
                continue;
            }

            // Проверяем, появились ли результаты на сервере (обычно ключ status: "ok" и массив не пустой)
            const resultsTable = json_data.data?.results || [];
            
            if (resultsTable.length > 0) {
                console.log(`🎉 Найдены результаты для игры ID: ${gameId}`);

                // Ищем нашу команду "TEAM_NAME" в таблице результатов игры
                // Приводим к нижнему регистру и убираем кавычки для надежности
                const cleanTeamName = env.TEAM_NAME.toLowerCase().replace(/[«»"']/g, "");
                const ourResult = resultsTable.find(r => 
                    r.team && r.team.title && r.team.title.toLowerCase().replace(/[«»"']/g, "").includes(cleanTeamName)
                );

                if (ourResult) {
                    const position = ourResult.place || "не указано";
                    const totalPoints = ourResult.total || 0;

                    let gameTitle = "Прошедший Квиз, плиз!";
                    const pollData = await env.QUIZ_DB.get(keyObj.name);
                    if (pollData) {
                        const parsedPoll = JSON.parse(pollData);
                        const fullGameObj = await env.QUIZ_DB.get(`poll:${parsedPoll.pollId}`);
                        if (fullGameObj) gameTitle = JSON.parse(fullGameObj).title || gameTitle;
                    }

                    // Формируем победный текст
                    let text = `🏆 <b>РЕЗУЛЬТАТЫ ИГРЫ ДОСТУПНЫ!</b> 🏆\n\n`;
                    text += `Команда, на сайте опубликовали итоги игры:\n\n`;
                    text += `🎯 <b>Игра:</b> ${gameTitle}\n`;
                    text += `🎖 <b>Занятое место: ${position} место\n`;
                    text += `✨ <b>Всего баллов:</b> <code>${totalPoints}</code>\n\n`;
                    text += `<i>Красавчики! Гордимся каждым пончиком! 💪</i>`;
                    await sendTelegramMessage(targetChatId, text, env);

                    // // 2. Сборка чистого HTML/CSS кода таблицы раундов по всем командам
                    let rowsHtml = "";
                    resultsTable.forEach((row) => {
                        const isOurTeam = row.team?.title?.toLowerCase().replace(/[«»"']/g, "").includes(env.TEAM_NAME.toLowerCase().replace(/[«»"']/g, ""));
                        const rowClass = isOurTeam ? 'class="our-team"' : '';
                        const r = row.rounds || {};
                        rowsHtml += `
                            <tr data-v-001abdab="" ${rowClass}>
                                <th data-v-001abdab="">${row.place}</th>
                                <th data-v-001abdab="">${row.team?.title || "Без названия"}</th>
                                <th data-v-001abdab="">${row.total || 0}</th>
                                <th data-v-001abdab="">${r["1"] || 0}</th>
                                <th data-v-001abdab="">${r["2"] || 0}</th>
                                <th data-v-001abdab="">${r["3"] || 0}</th>
                                <th data-v-001abdab="">${r["4"] || 0}</th>
                                <th data-v-001abdab="">${r["5"] || 0}</th>
                                <th data-v-001abdab="">${r["6"] || 0}</th>
                                <th data-v-001abdab="">${r["7"] || 0}</th>
                            </tr>`;
                    });

                    const fullHtml = `
                    <style>
                        #vueLatestTable table tr td[data-v-001abdab] {
                            padding: .3rem .625rem;
                            text-align: center
                        }
                        #vueLatestTable[data-v-f164737e] {
                            background-color: #fff;
                            color: #333 !important;
                            cursor: pointer;
                            font-weight: 500;
                            margin: 0 auto;
                            -webkit-user-select: none;
                            -moz-user-select: none;
                            user-select: none;
                            border-radius: 2px;
                            box-shadow: 0 2px 8px #63636333;
                        }
                        * {
                            box-sizing: border-box;
                            font-family: Gilroy;
                            font-size: 16px;
                        }
                        tr {
                            display: table-row;
                            vertical-align: inherit;
                            unicode-bidi: isolate;
                            border-color: inherit;
                        }
                        td {
                            display: table-cell;
                            vertical-align: inherit;
                            unicode-bidi: isolate;
                        }
                        .our-team { background: #fef08a !important; font-weight: bold; }
                    </style>
                    <div data-v-001abdab="" data-v-f164737e="" id="vueLatestTable" class="defaultTheme">
                        <h2 style="margin: 0 0 15px 0; font-size: 22px; font-weight: bold; padding-bottom: 12px; padding: .3rem .625rem;">${gameTitle}</h2>
                        <table data-v-001abdab="" aria-hidden="true">
                            <thead data-v-001abdab="">
                                <tr data-v-001abdab="">
                                    <th data-v-001abdab="">Место</th>
                                    <th data-v-001abdab="">Название команды</th>
                                    <th data-v-001abdab="">Итого</th>
                                    <th data-v-001abdab="">1 раунд</th>
                                    <th data-v-001abdab="">2 раунд</th>
                                    <th data-v-001abdab="">3 раунд</th>
                                    <th data-v-001abdab="">4 раунд</th>
                                    <th data-v-001abdab="">5 раунд</th>
                                    <th data-v-001abdab="">6 раунд</th>
                                    <th data-v-001abdab="">7 раунд</th>
                                </tr>
                            </thead>
                            <tbody data-v-001abdab="">${rowsHtml}</tbody>                   
                        </table>
                    </div>`;

                    // 3. Отправляем HTML на отрисовку в Pictify.io API
                    const renderResponse = await fetch("https://api.pictify.io/image", {
                        method: "POST",
                        headers: { 
                            "Content-Type": "application/json",
                            "Authorization": "Bearer a91e3e1a22429577ff8ac96eece8db47b303953625240a7277a0a5a79bdbac10"
                        },
                        body: JSON.stringify({
                            html: fullHtml,
                            width: 900,
                            "selector": "body",
                            "fileExtension": "png" // Задаем жесткую ширину картинки таблицы
                        })
                    });

                    if (renderResponse.status === 200) {
                        // Читаем JSON-ответ от Pictify, чтобы забрать ссылку на готовую картинку
                        const resData = await renderResponse.json();
                        const imageUrl = resData.url || renderResponse.url; // Достаем URL картинки

                        if (imageUrl) {
                            // ВАЖНО: Скачиваем саму PNG-картинку по полученному адресу
                            const imageResponse = await fetch(imageUrl);
                            const imageBlob = await imageResponse.blob();

                            // 4. Отправляем скачанный PNG-файл в Telegram чат
                            const formData = new FormData();
                            formData.append("chat_id", targetChatId);
                            formData.append("photo", imageBlob, "result_table.png");
                            formData.append("caption", `📊 Таблица результатов: ${gameTitle}`);

                            await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
                                method: "POST",
                                body: formData
                            });
                        }
                    }
                }
                    
                // ОЧЕНЬ ВАЖНО: Удаляем игру из базы активного отслеживания, чтобы исключить дублирование сообщений!
                await env.QUIZ_DB.delete(keyObj.name);
            }  
        }
    } catch (error) {
        console.error("Ошибка в функции checkLiveResults:", error.message);
    }
}
