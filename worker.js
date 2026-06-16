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

function tgUrl(env, method) {
    return `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
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

                if (payload.callback_query) {
                    ctx.waitUntil(handleCallbackQuery(payload.callback_query, env));
                }

                // Проверяем, есть ли текстовое сообщение
                if (payload.message && payload.message.text) {
                    const chatId = payload.message.chat.id;
                    const text = payload.message.text;
                    
                     console.log(`Получен текст: "${text}" от чата: ${chatId}`);

                    if (text.startsWith("/stats")) ctx.waitUntil(sendStats(chatId, env));
                    if (text.startsWith("/nextgame")) ctx.waitUntil(sendNextGamesList(chatId, env));
                    if (text.startsWith("/remind")) ctx.waitUntil(forceTestReminder(chatId, env));
                    if (text.startsWith("/halloffame") || text.startsWith("/hof")) {
                        ctx.waitUntil(sendHallOfFame(chatId, env));
                    }

                    if (text.startsWith("/testresults")) {
                        ctx.waitUntil(checkLiveResults(chatId, env));
                    }

                    if (text.startsWith("/poll")) {
                        ctx.waitUntil(sendPollMenu(chatId, env));
                    }

                    if (text.startsWith("/ping")) ctx.waitUntil(pingTeam(chatId, env));

                    if (text.startsWith("/quiz")) ctx.waitUntil(sendTriviaQuiz(chatId, env));
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
    const currentDay = localTime.getDate(); // Какое сегодня число (1-31)
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

    if (currentDay === 1 && currentHour === 0) {
        await updateTodoMessage(env);
    }
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
                    const gameUrl = `https://${env.CITY_SLUG}.quizplease.ru/game/${game.id}`;

                    let singleGameText = `🎯 <a href="${gameUrl}"><b>${title}</b></a>\n`;
                    singleGameText += `🗓 Когда: ${gameDate} (${dayOfWeekString}) в ${gameTime}\n`;
                    singleGameText += `📍 Где: ${placeTitle}\n`;
                    
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

// --- ФУНКЦИЯ ВЫВОДА МЕНЮ ИГР ДЛЯ СОЗДАНИЯ ОПРОСА ---
async function sendPollMenu(targetChatId, env) {
    const headers = { "User-Agent": "Mozilla/5.0" };
    try {
        const response = await fetch(getScheduleApi(env), { headers });
        if (response.status !== 200) {
            await sendTelegramMessage(targetChatId, `❌ Ошибка API Квиз, плиз! (${response.status})`, env);
            return;
        }

        const json_data = await response.json();
        const gamesList = json_data.data?.data || [];

        if (gamesList.length === 0) {
            await sendTelegramMessage(targetChatId, "📅 <b>Афиша игр:</b> На данный момент доступных игр для сбора нет.", env);
            return;
        }

        let inlineKeyboard = [];

        gamesList.forEach((game) => {
            const title = game.title || "Без названия";
            const rawDate = game.date || ""; 
            let gameDate = "Дата не указана";

            if (rawDate) {
                gameDate = rawDate.split(" ")[0]; // Извлекаем только DD.MM.YYYY
            }

            // Формируем текст на кнопке (Дата + Имя игры)
            const buttonText = `${gameDate} — ${title}`;
            
            // В скрытый параметр кнопки зашиваем ID игры
            inlineKeyboard.push([
                {
                    text: buttonText,
                    callback_data: `btn:${game.id}`
                }
            ]);
        });

        // +++ Добавляем в самый конец меню кнопку отмены +++
        inlineKeyboard.push([
            {
                text: "❌ Отмена",
                callback_data: "cancel_menu" // Специальный скрытый сигнал для отмены
            }
        ]);

        await fetch(tgUrl(env, "sendMessage"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: targetChatId,
                text: "📊 <b>Создание опроса для сбора состава</b>\n\nВыберите игру из списка ниже. Бот автоматически закроет это меню и опубликует полноценный опрос для нашей команды: 👇",
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: inlineKeyboard }
            })
        });

    } catch (error) {
        console.error("Ошибка меню опросов:", error);
        await sendTelegramMessage(targetChatId, "❌ Произошла ошибка при загрузке меню игр.", env);
    }
}

// --- ФУНКЦИЯ ОБРАБОТКИ КЛИКА ПО КНОПКЕ ИГРЫ ---
async function handleCallbackQuery(callbackQuery, env) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data || "";

    // +++ ЛОВИМ НАЖАТИЕ КНОПКИ ОТМЕНЫ МЕНЮ ОПРОСОВ +++
    if (data === "cancel_menu") {
        try {
            // 1. Гасим анимацию часиков на кнопке Telegram
            await fetch(tgUrl(env, "answerCallbackQuery"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ callback_query_id: callbackQuery.id })
            });

            // 2. Удаляем само сообщение с кнопками из чата
            await fetch(tgUrl(env, "deleteMessage"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, message_id: messageId })
            });
        } catch (err) {
            console.error("Ошибка при отмене меню:", err);
        }
        return; // Мгновенно завершаем работу функции
    }

    if (data.startsWith("png:")) {
        ctx.waitUntil(executeLivePing(chatId, messageId, data.replace("png:", ""), callbackQuery.id, env));
        return;
    }

    if (!data.startsWith("btn:")) return;
    const gameId = data.replace("btn:", "");

    const headers = { "User-Agent": "Mozilla/5.0" };

    try {
        // Гасим анимацию часиков на кнопке Telegram
        await fetch(tgUrl(env, "answerCallbackQuery"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: callbackQuery.id })
        });

        // Запрашиваем расписание, чтобы найти подробные данные игры по ID
        const response = await fetch(getScheduleApi(env), { headers });
        if (response.status !== 200) return;

        const json_data = await response.json();
        const gamesList = json_data.data?.data || [];
        const game = gamesList.find(g => g.id === gameId);
        if (!game) return;

        const title = game.title || "Квиз, плиз!";
        const placeTitle = game.place?.title || "Место уточняется";
        const rawDate = game.date || ""; 
        
        let dayOfWeekString = "";
        let gameDate = "Дата не указана";
        let gameTime = "19:30";

        if (rawDate) {
            const dateParts = rawDate.split(" ");
            gameDate = dateParts[0];
            gameTime = dateParts[1] || "19:30";
            const parts = gameDate.split("."); 
            if (parts.length === 3) {
                const dateObj = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
                dayOfWeekString = DAYS_OF_WEEK[dateObj.getDay()];
            }
        }

        // Удаляем старое меню с кнопками, чтобы оно не висело в чате
        await fetch(tgUrl(env, "deleteMessage"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId })
        });

        // Создаем текст и отправляем опрос в группу
        const dateInfo = `${gameDate} (${dayOfWeekString}) в ${gameTime}`;
        const pollQuestion = `Кто идет на Квиз?\n\n📝 ${title}\n📅 ${dateInfo}\n📍 ${placeTitle}`;

        const pollResponse = await fetch(tgUrl(env, "sendPoll"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                question: pollQuestion,
                options: JSON.stringify(["Иду", "Иду + 1", "Без меня"]),
                is_anonymous: false,
                allows_multiple_answers: false,
                type: "regular"
            })
        });

        // Записываем ID созданного опроса и ID игры в базу данных KV
        if (pollResponse.status === 200 && env.QUIZ_DB) {
            const resJson = await pollResponse.json();
            const pollId = resJson.result?.poll?.id;

            if (pollId) {
                const gameObject = {
                    gameId: gameId, // СВЕРХВАЖНО: Теперь ID игры надежно сохранен в базу опроса
                    title: title,
                    date: gameDate,
                    time: gameTime,
                    place: placeTitle,
                    voters: {}
                };
                await env.QUIZ_DB.put(`poll:${pollId}`, JSON.stringify(gameObject));
                await env.QUIZ_DB.put(`date:${gameDate}`, pollId);
                await env.QUIZ_DB.put(`active_game:${gameId}`, JSON.stringify({ pollId: pollId, date: gameDate, time: gameTime }));
            }
        }

        // Добавляем игры в  список задач
        await addGameToTodo(gameId, title, gameDate, env);

    } catch (error) {
        console.error("Ошибка кнопки:", error);
    }
}

// --- Функция отслеживания кликов на кнопки опроса ---
async function handlePollAnswer(pollAnswer, env) {
    if (!env.QUIZ_DB) return;

    const pollId = pollAnswer.poll_id;
    const userId = pollAnswer.user.id;
    const firstName = pollAnswer.user.first_name || "Игрок";
    const optionIds = pollAnswer.option_ids || [];
    const username = pollAnswer.user.username || "";

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
        
        gameObject.voters[userId] = { name: firstName, username: username, status: statusText, count: count };
    }

    await env.QUIZ_DB.put(`poll:${pollId}`, JSON.stringify(gameObject));

    // +++ НОВАЯ ЛОГИКА: АВТОМАТИЧЕСКИЙ ПОДСЧЕТ ЛИМИТА СТОЛА (9 ЧЕЛОВЕК) +++
    try {
        let totalSeats = 0;
        if (gameObject.voters) {
            for (const user of Object.values(gameObject.voters)) {
                if (user && user.count > 0) {
                    totalSeats += user.count; // Плюсуем места (Иду = 1, Иду + 1 = 2)
                }
            }
        }

        const MAX_SEATS = 9; // Официальный лимит стола Квиз, плиз!

        // Проверяем, набран ли состав впервые
        // Чтобы бот не спамил при каждом клике после 9, проверяем точное совпадение или флаг
        const limitAlertSentKey = `alert_sent:${pollId}`;
        const isAlertSent = await env.QUIZ_DB.get(limitAlertSentKey);

        if (totalSeats >= MAX_SEATS && !isAlertSent) {
            console.log(`🔥 Основной состав собран (${totalSeats}/${MAX_SEATS}). Отправляю алерт.`);

            let alertText = `🔥 <b>ОСНОВНОЙ СОСТАВ СОБРАН! (${totalSeats}/${MAX_SEATS})</b> 🔥\n\n`;
            alertText += `🍩 Команда, у нас полный стол на игру «<b>${gameObject.title}</b>»!\n`;
            alertText += `⏳ Все последующие голоса автоматически пойдут в <b>запасной состав</b> на случай замен.\n\n`;
            alertText += `💳 <i>Капитану пора регистрировать команду на сайте!</i>`;

            await sendTelegramMessage(env.CHAT_ID, alertText, env);

            // Ставим метку в базу, чтобы бот отправил это поздравление строго 1 раз
            await env.QUIZ_DB.put(limitAlertSentKey, "true");
        } 
        // Если люди поубирали голоса и мест стало меньше 9, сбрасываем метку для возможности повторного триггера
        else if (totalSeats < MAX_SEATS && isAlertSent) {
            await env.QUIZ_DB.delete(limitAlertSentKey);
        }
    } catch (limitErr) {
        console.error("Ошибка контроля лимита стола:", limitErr);
    }

    // +++ ШАГ Б: АВТОМАТИЧЕСКОЕ ОБНОВЛЕНИЕ ГЛОБАЛЬНОГО СПИСКА КОМАНДЫ +++
    try {
        const userId = pollAnswer.user.id;
        const firstName = pollAnswer.user.first_name || "Игрок";
        const username = pollAnswer.user.username || "";

        const cachedTeam = await env.QUIZ_DB.get("global_team_members");
        let teamList = cachedTeam ? JSON.parse(cachedTeam) : [];

        // Проверяем, есть ли уже этот пользователь в нашей базе по его уникальному ID
        const exists = teamList.some(member => member.id === userId);

        if (!exists) {
            // Если игрока нет, добавляем его структуру в массив
            teamList.push({ id: userId, name: firstName, username: username });
            // Сохраняем обновленный состав команды обратно в KV
            await env.QUIZ_DB.put("global_team_members", JSON.stringify(teamList));
            console.log(`👤 В глобальный список команды успешно добавлен новый игрок: ${firstName}`);
        } else {
            // Если игрок уже был, но сменил ник в Telegram, точечно обновим его данные
            const index = teamList.findIndex(member => member.id === userId);
            if (teamList[index].username !== username || teamList[index].name !== firstName) {
                teamList[index].name = firstName;
                teamList[index].username = username;
                await env.QUIZ_DB.put("global_team_members", JSON.stringify(teamList));
            }
        }
    } catch (err) {
        console.error("Ошибка автопополнения базы игроков:", err);
    }
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
    try {
        await fetch(tgUrl(env, "sendMessage"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: "HTML"
            })
        });
    } catch (err) { console.error("Ошибка отправки в Telegram:", err); }
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
                    const position = parseInt(ourResult.place || ourResult.rank, 10) || 99;
                    const totalPoints = ourResult.total || 0;

                    let gameTitle = "Прошедший Квиз, плиз!";
                    const pollData = await env.QUIZ_DB.get(keyObj.name);
                    if (pollData) {
                        const parsedPoll = JSON.parse(pollData);
                        const fullGameObj = await env.QUIZ_DB.get(`poll:${parsedPoll.pollId}`);
                        if (fullGameObj) gameTitle = JSON.parse(fullGameObj).title || gameTitle;
                    }
                    
                    let celebrationText = "";
                    if (position === 1) {
                        celebrationText = `🥇 <b>ЧЕМПИОНЫ! ПЕРВОЕ МЕСТО!</b> 🥇\n\n🍩 Пончики, это абсолютный триумф! Мы разнесли этот квиз в щепки и забрали золото! Невероятная игра, гордимся каждым! Вы лучшие! 🎉🥳👑`;
                    } else if (position <= 3) {
                        celebrationText = `🏆 <b>МЫ В ТРОЙКЕ ЛИДЕРОВ! ПОДИУМ!</b> 🏆\n\n🍩 Шикарный результат! Залетели на пьедестал почета и забрали диплом! До золота оставалось совсем чуть-чуть, в следующий раз оно точно наше! Настоящие топ-игроки! 🎉🥈🥉💪`;
                    } else if (position <= 5) {
                        celebrationText = `🔥 <b>МЫ В ТОП-5 ЛУЧШИХ КОМАНД!</b> 🔥\n\n🍩 Отличная игра! Уверенно закрепились в пятерке сильнейших команд города. Боролись до последнего вопроса, отличный сбор состава и крутой результат! Шаг за шагом к вершине! 🚀👏`;
                    } else if (position <= 10) {
                        celebrationText = `📊 <b>СТАБИЛЬНЫЙ ТОП-10!</b> 📊\n\n🍩 Хорошая, плотная игра! Вошли в десятку лучших, набрали приличное количество баллов в общий зачет. Разберем ошибки, поднажмем на следующем квизе и ворвемся на подиум! 👍✨`;
                    } else if (position <= 20) {
                        celebrationText = `🍩 Отыграли в двадцатке сильнейших. Игра была непростой, вопросы попались с подвохом, но мы держались достойно! Главное — отлично провели время вместе! 🤝🥨`;
                    } else {
                        celebrationText = `🦾 <b>Главное не победа, а пончики к чаю!</b> 🦾\n\n🍩 Этот квиз выдался максимально жестким, и мы оказались за пределами топ-20. Но пончики не сдаются! Это просто разминка перед грандиозным камбэком. Набираемся сил и берем реванш! 🍩❤️⚔️`;
                    }
                    
                    // Формируем победный текст
                    let text = `🏆 <b>РЕЗУЛЬТАТЫ ИГРЫ ОПУБЛИКОВАНЫ!</b> 🏆\n\n`;
                    text += `${celebrationText}\n\n`;
                    text += `🎯 <b>Игра:</b> ${gameTitle}\n`;
                    text += `🎖 <b>Занятое место: ${position} место\n`;
                    text += `✨ <b>Всего баллов:</b> <code>${totalPoints}</code>\n\n`;
                    
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

                            await fetch(tgUrl(env, "sendPhoto"), {
                                method: "POST",
                                body: formData
                            });
                        }
                    }

                    let todoData = await env.QUIZ_DB.get("todo_list", "json");
                    if (todoData && todoData.games.length > 0) {
                        // Ищем нашу игру в общем списке задач
                        const todoGameIndex = todoData.games.findIndex(g => g.id === gameId);
                        
                        if (todoGameIndex !== -1 && todoData.games[todoGameIndex].status !== "done") {
                            // Переводим статус в "Выполнено"
                            todoData.games[todoGameIndex].status = "done";
                            
                            // Сохраняем изменения и тихо обновляем закрепленный список
                            await env.QUIZ_DB.put("todo_list", JSON.stringify(todoData));
                            await updateTodoMessage(env);
                            console.log(`Игра #${gameId} автоматически отмечена как выполненная в To-Do.`);
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

// --- ФУНКЦИЯ ВЫВОДА МЕНЮ ВЫБОРА ОПРОСА ДЛЯ ПИНГА ---
async function pingTeam(targetChatId, env) {
    if (!env.QUIZ_DB) return;

    try {
        const cachedTeam = await env.QUIZ_DB.get("global_team_members");
        if (!cachedTeam) {
            await sendTelegramMessage(targetChatId, "ℹ️ <b>Пинг пока невозможен:</b> В базе данных еще нет сохраненных игроков.", env);
            return;
        }

        // Вытаскиваем из базы список всех когда-либо созданных опросов
        const list = await env.QUIZ_DB.list({ prefix: "poll:" });
        if (!list.keys || list.keys.length === 0) {
            await sendTelegramMessage(targetChatId, "⚠️ <b>Пинг отменен:</b> В чате пока нет запущенных опросов на игры.", env);
            return;
        }

        let inlineKeyboard = [];

        // Перебираем все опросы из базы
        for (const keyObj of list.keys) {
            const pollData = await env.QUIZ_DB.get(keyObj.name);
            if (!pollData) continue;

            const game = JSON.parse(pollData);
            const pollId = keyObj.name.replace("poll:", "");

            // Название кнопки (Дата игры + Имя игры)
            const buttonText = `${game.date} — ${game.title}`;

            // Зашиваем ID опроса в префикс png:
            inlineKeyboard.push([
                {
                    text: buttonText,
                    callback_data: `png:${pollId}`
                }
            ]);
        }

        // Отправляем меню выбора в чат
        await fetch(tgUrl(env, "sendMessage"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: targetChatId,
                text: "🔔 <b>Выбор опроса для пинга прогульщиков</b>\n\nВ чате найдено несколько активных сборов. Выберите нужную игру, чтобы тегнуть молчунов именно по ней: 👇",
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: inlineKeyboard }
            })
        });

    } catch (error) {
        console.error("Ошибка вывода меню пинга:", error);
    }
}

// --- ФУНКЦИЯ ВЫПОЛНЕНИЯ ТОЧЕЧНОГО ПИНГА ПО ВЫБРАННОЙ ИГРЕ ---
async function executeLivePing(chatId, messageId, pollId, callbackQueryId, env) {
    try {
        // 1. Гасим часики анимации кнопки в Telegram
        await fetch(tgUrl(env, "answerCallbackQuery"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: callbackQueryId })
        });

        const cachedTeam = await env.QUIZ_DB.get("global_team_members");
        const allTeamMembers = JSON.parse(cachedTeam || "[]");

        // 2. Читаем из базы данные именно выбранного опроса
        const pollData = await env.QUIZ_DB.get(`poll:${pollId}`);
        if (!pollData) return;

        const game = JSON.parse(pollData);
        const currentVoters = game.voters || {};

        // 3. Вычисляем прогульщиков конкретно для этой игры
        let silentPlayers = [];
        allTeamMembers.forEach(player => {
            if (!currentVoters[player.id]) {
                if (player.username) {
                    silentPlayers.push(`@${player.username}`);
                } else {
                    silentPlayers.push(`<b>${player.name}</b>`);
                }
            }
        });

        // 4. Удаляем меню выбора кнопок из чата
        await fetch(tgUrl(env, "deleteMessage"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId })
        });

        // 5. Публикуем пинг-сообщение
        if (silentPlayers.length > 0) {
            let pingText = `🍩 <b>Пончики, просыпаемся!</b> 🍩\n\n`;
            pingText += `Напоминаем про сбор на квиз «<b>${game.title}</b>» (${game.date} в ${game.time}). Вы ещё не отметились в опросе:\n\n`;
            pingText += `${silentPlayers.join(", ")}\n\n`;
            pingText += `👇 <i>Пожалуйста, проголосуйте в активном опросе выше!</i>`;
            
            await sendTelegramMessage(chatId, pingText, env);
        } else {
            await sendTelegramMessage(chatId, `✅ <b>Полный сбор на игру «${game.title}»!</b> Все участники команды уже проголосовали. Прогульщиков нет! 🥰`, env);
        }

    } catch (error) {
        console.error("Ошибка выполнения точечного пинга:", error);
    }
}

async function translateText(text, env) {
    if (!env || !env.AI) {
        console.log("⚠️ Workers AI не подключен в env, возвращаю оригинал.");
        return text;
    }

    try {
        // Запускаем встроенную модель перевода Cloudflare Workers AI
        const aiResponse = await env.AI.run("@cf/meta/m2m100-1.2b", {
            text: text,
            source_lang: "english", // Язык оригинала в базе Open Trivia DB
            target_lang: "russian"  // Язык перевода для нашей команды
        });

        if (aiResponse && aiResponse.translated_text) {
            return aiResponse.translated_text
                .replace(/&quot;/g, '"')
                .replace(/&#039;/g, "'")
                .replace(/&amp;/g, '&');
        }
    } catch (e) {
        console.error("Ошибка Workers AI при переводе:", e);
    }
    return text; // Если перевод по какой-то причине дал сбой, возвращаем английский оригинал
}

// --- ФУНКЦИЯ ОТПРАВКИ НА ТИВНОЙ ВИКТОРИНЫ TELEGRAM (/quiz) ---
async function sendTriviaQuiz(targetChatId, env) {
    try {
        // Запрашиваем 1 случайный вопрос с 4 вариантами ответов из базы Open Trivia DB
        const response = await fetch("https://opentdb.com/api.php?amount=1");
        if (response.status !== 200) {
            await sendTelegramMessage(targetChatId, "❌ Не удалось загрузить вопрос из базы знаний. Попробуйте еще раз!", env);
            return;
        }

        const json_data = await response.json();
        const questionData = json_data.results?.[0];
        if (!questionData) return;

        // Переводим категорию, текст вопроса и правильный ответ на русский язык
        const categoryRu = await translateText(questionData.category, env);
        const questionRu = await translateText(questionData.question, env);
        const correctAnswerRu = await translateText(questionData.correct_answer, env);
        
        let answersOptions = [];
        for (const ans of questionData.incorrect_answers) {
            answersOptions.push(await translateText(ans, env));
        }
        answersOptions.push(correctAnswerRu);

        // Перемешиваем варианты ответов случайным образом (алгоритм Фишера-Йетса)
        for (let i = answersOptions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [answersOptions[i], answersOptions[j]] = [answersOptions[j], answersOptions[i]];
        }

        // Вычисляем индекс, под которым в перемешанном массиве оказался правильный ответ
        const correctOptionIndex = answersOptions.indexOf(correctAnswerRu);

        // Формируем текст вопроса (лимит Telegram Bot API на длину поля question — 300 символов)
        const pollQuestion = `🎲 [Разминка] Категория: ${categoryRu}\n\n${questionRu}`;
        const finalQuestion = pollQuestion.substring(0, 299); // Защита от обрезания строки

        // Отправляем официальный Quiz-опрос через нашу общую константу tgUrl
        await fetch(tgUrl(env, "sendPoll"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: targetChatId,
                question: finalQuestion,
                options: JSON.stringify(answersOptions),
                is_anonymous: false,              // Открытый опрос, чтобы видеть успехи каждого пончика
                type: "quiz",                     // Включаем режим нативной викторины
                correct_option_id: correctOptionIndex, // Передаем ID правильного ответа для анимации
                explanation: `Правильный ответ: ${correctAnswerRu}` // Подсказка, которая всплывет при ошибке
            })
        });

    } catch (error) {
        console.error("Критическая ошибка модуля викторин:", error);
        await sendTelegramMessage(targetChatId, "❌ Произошла ошибка при сборке викторины разминки.", env);
    }
}

// --- МОДУЛЬ СПИСКА ЗАДАЧ (TO-DO) ---

// Вспомогательная функция для определения дня недели по строке даты (ДД.ММ.ГГГГ)
function getRussianDayOfWeek(dateStr) {
    if (!dateStr) return "Воскресенье"; // Заглушка на случай ошибки
    // Если дата приходит в формате "18.06.2026"
    const parts = dateStr.split('.');
    if (parts.length === 3) {
        const date = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
        const days = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
        return days[date.getDay()];
    }
    return "День игры"; // Если формат строки нестандартный
}

// Формирование текста и тихое обновление (или создание) закрепленного сообщения
async function updateTodoMessage(env) {

    const localTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Krasnoyarsk" }));
    const year = localTime.getFullYear();
    const month = String(localTime.getMonth() + 1).padStart(2, '0');
    const currentMonthKey = `${year}-${month}`; // Формат "2026-06"

    const monthsRu = [
        "ЯНВАРЬ", "ФЕВРАЛЬ", "МАРТ", "АПРЕЛЬ", "МАЙ", "ИЮНЬ",
        "ИЮЛЬ", "АВГУСТ", "СЕНТЯБРЬ", "ОКТЯБРЬ", "НОЯБРЬ", "ДЕКАБРЬ"
    ];
    const monthName = monthsRu[localTime.getMonth()];

    // Получаем текущие задачи из базы
    let todoData = await env.QUIZ_DB.get("todo_list", "json");
    if (!todoData) {
        todoData = { pinned_message_id: null, current_month: currentMonthKey, games: [] };
    }

    // Ротация: если месяц сменился, сбрасываем старый айди закрепа
    if (todoData.current_month !== currentMonthKey) {
        todoData.pinned_message_id = null;
        todoData.current_month = currentMonthKey;
        // Оставляем только те игры, которые запланированы на новый месяц или позже
        todoData.games = todoData.games.filter(g => {
            const gParts = g.raw_date.split('.');
            if (gParts.length === 3) {
                return `${gParts[2]}-${gParts[1]}` >= currentMonthKey;
            }
            return true;
        });
    }

    // Собираем текст списка задач
    let messageText = `📌 *СПИСОК ЗАДАЧ НА ${monthName} ${year}*\n\n`;
    
    if (todoData.games.length === 0) {
        messageText += "⏳ Задач пока нет. Запустите /poll для добавления игры!";
    } else {
        // Сортируем игры по дате (от старых к новым)
        todoData.games.sort((a, b) => {
            const aArr = a.raw_date.split('.').reverse().join('');
            const bArr = b.raw_date.split('.').reverse().join('');
            return aArr.localeCompare(bArr);
        });

        todoData.games.forEach((game, index) => {
            let statusEmoji = "⏳";
            let statusText = "Опрос активен";
            
            if (game.status === "done") {
                statusEmoji = "✅";
                statusText = "Сыграно!";
            } else if (game.status === "canceled") {
                statusEmoji = "❌";
                statusText = "Отменено";
            }

            messageText += `${statusEmoji} ${index + 1}. *${game.day_of_week}*, ${game.date_str}: #${game.id} [${game.title}] — _${statusText}_\n`;
        });
    }

    messageText += `\n_🔄 Обновлено автоматически в ${String(localTime.getHours()).padStart(2, '0')}:${String(localTime.getMinutes()).padStart(2, '0')}_`;

    // Отправка или редактирование в Telegram
    const chatId = env.CHAT_ID;
    
    if (todoData.pinned_message_id) {
        // Если сообщение уже висит — тихо обновляем его текст через editMessageText
        try {
            await fetch(tgUrl(env, "editMessageText"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: todoData.pinned_message_id,
                    text: messageText,
                    parse_mode: "Markdown"
                })
            });
        } catch (e) {
            console.error("Ошибка обновления закрепленного сообщения:", e);
            todoData.pinned_message_id = null; // Если сообщение удалили, заставим пересоздать
        }
    }

    if (!todoData.pinned_message_id) {
        // Если закрепа еще нет — публикуем новое сообщение
        try {
            const sendRes = await fetch(tgUrl(env, "sendMessage"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: messageText,
                    parse_mode: "Markdown"
                })
            });
            const sendData = await sendRes.json();
            
            if (sendData.ok) {
                todoData.pinned_message_id = sendData.result.message_id;
                
                // Сразу же закрепляем его в чате
                await fetch(tgUrl(env, "pinChatMessage"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: todoData.pinned_message_id,
                        disable_notification: true
                    })
                });
            }
        } catch (e) {
            console.error("Ошибка публикации или закрепа сообщения:", e);
        }
    }

    // Сохраняем обновленную структуру данных обратно в KV
    await env.QUIZ_DB.put("todo_list", JSON.stringify(todoData));
}

function parseGameDate(rawDate) {
    // Дефолтные значения на случай сбоя
    let dayOfWeek = "День игры";
    let dateStr = rawDate;

    if (!rawDate) return { dayOfWeek, dateStr };

    const parts = rawDate.split('.'); // Разбиваем "18.06.2026"
    if (parts.length === 3) {
        const day = parseInt(parts[0], 10);
        const monthIdx = parseInt(parts[1], 10) - 1;
        const year = parseInt(parts[2], 10);

        const date = new Date(year, monthIdx, day);
        
        const months = [
            "января", "февраля", "марта", "апреля", "мая", "июня",
            "июля", "августа", "сентября", "октября", "ноября", "декабря"
        ];

        dayOfWeek = DAYS_OF_WEEK[date.getDay()];
        dateStr = `${day} ${months[monthIdx]}`; // На выходе: "18 июня"
    }

    return { dayOfWeek, dateStr };
}

// Автоматическое добавление игры в To-Do при вызове /poll
async function addGameToTodo(gameId, gameTitle, rawDate, env) {
    let todoData = await env.QUIZ_DB.get("todo_list", "json");
    if (!todoData) {
        const tzOffset = 7 * 60 * 60 * 1000;
        const localTime = new Date(Date.now() + tzOffset);
        const currentMonthKey = `${localTime.getFullYear()}-${String(localTime.getMonth() + 1).padStart(2, '0')}`;
        todoData = { pinned_message_id: null, current_month: currentMonthKey, games: [] };
    }

    if (!todoData.games.some(g => g.id === gameId)) {
        // Вызываем наш новый парсер даты
        const { dayOfWeek, dateStr } = parseGameDate(rawDate);
        
        todoData.games.push({
            id: gameId,
            title: gameTitle,
            raw_date: rawDate,   // "18.06.2026"
            date_str: dateStr,   // "18 июня"
            day_of_week: dayOfWeek,
            status: "pending"
        });

        await env.QUIZ_DB.put("todo_list", JSON.stringify(todoData));
        await updateTodoMessage(env);
    }
}