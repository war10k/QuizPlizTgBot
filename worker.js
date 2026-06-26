// --- Динамическая сборка ссылок под любой город ---
function getApiEndpoints(env) {

    const URLS = `https://rating-api.quizplease.ru/api/external/team?city=${env.CITY_SLUG}`;

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
        ctx.waitUntil(runDailyCronTasks(env));
    },

    async fetch(request, env, ctx) {
        if (request.method !== "POST") return new Response("OK");
        try {
            const payload = await request.json();
            
            if (payload.poll_answer) {
                ctx.waitUntil(handlePollAnswer(payload.poll_answer, env));
            } else if (payload.callback_query) {
                ctx.waitUntil(handleCallbackQuery(payload.callback_query, env));
            } else if (payload.message && payload.message.text) {
                ctx.waitUntil(handleCommands(payload.message, env));
            }
        } catch (e) {
            console.error("Критическая ошибка fetch-роутера:", e);
        }
        return new Response("OK");
    }
};

// Хелпер сборки динамических URL для Telegram API, который вы просили вернуть
const tgUrl = (env, method) => `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

// Главный обработчик текстовых команд
async function handleCommands(msg, env) {
    const text = msg.text.trim();
    const chatId = msg.chat.id;

    if (text.startsWith("/stats")) {
        await sendStats(chatId, env);
    } else if (text.startsWith("/nextgame")) {
        await sendNextGamesList(chatId, env);
    } else if (text.startsWith("/pollweek")) {
        await sendNextWeekPoll(chatId, env);
    } else if (text.startsWith("/poll")) {
        await showPollMenu(chatId, env);
    } else if (text.startsWith("/ping")) {
        await pingTeam(chatId, env);
    } else if (text.startsWith("/hof") || text.startsWith("/halloffame")) {
        await sendHallOfFame(chatId, env);
    } else if (text.startsWith("/testresults")) {
        await checkLiveResultsTest(chatId, env);
    } else if (text.startsWith("/quiz")) {
        await sendTriviaQuiz(chatId, env);
    }
}

async function runDailyCronTasks(env) {
    
    const now = new Date();
    const localTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Krasnoyarsk" }));
    const currentDay = localTime.getDate(); // Какое сегодня число (1-31)
    const currentHour = localTime.getHours();

    // 1. Напоминания об играх отправляем строго один раз в день в 10:00 утра
    // 2. Проверяем изменения в общем рейтинге (Зал славы) тоже в 10:00
    if (currentHour === 10) {
        await checkAndSendReminders(env.CHAT_ID, env);
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
    
   const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

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
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

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
                            const dateObj = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
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
async function showPollMenu(targetChatId, env) {
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
            inlineKeyboard.push([{
                text: `${gameDate} — ${title}`,
                callback_data: `btn:${game.id}`
            }]);
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

// --- ФУНКЦИЯ СОЗДАНИЯ ОПРОСА НА СЛЕДУЮЩУЮ НЕДЕЛЮ ---
async function sendNextWeekPoll(targetChatId, env) {
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
            await sendTelegramMessage(targetChatId, "📅 <b>Афиша игр:</b> На данный момент доступных игр нет.", env);
            return;
        }

        // Определяем границы следующей недели
        const now = new Date();
        const localTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Krasnoyarsk" }));
        const dayOfWeek = localTime.getDay(); // 0 - воскресенье, 1 - понедельник
        const daysUntilNextMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
        
        const nextMonday = new Date(localTime);
        nextMonday.setDate(localTime.getDate() + daysUntilNextMonday);
        nextMonday.setHours(0, 0, 0, 0);

        const nextSunday = new Date(nextMonday);
        nextSunday.setDate(nextMonday.getDate() + 6);
        nextSunday.setHours(23, 59, 59, 999);

        let nextWeekGames = [];

        for (const game of gamesList) {
            const rawDate = game.date || "";
            if (!rawDate) continue;

            const dateParts = rawDate.split(" ");
            const gameDateStr = dateParts[0];
            const parts = gameDateStr.split(".");
            if (parts.length !== 3) continue;

            const gameDateObj = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
            
            if (gameDateObj >= nextMonday && gameDateObj <= nextSunday) {
                nextWeekGames.push(game);
            }
        }

        if (nextWeekGames.length === 0) {
            await sendTelegramMessage(targetChatId, "📅 На следующую неделю игр в расписании пока нет.", env);
            return;
        }

        let options = [];
        const shortDays = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

        for (const game of nextWeekGames) {
            const title = game.title || "Без названия";
            const rawDate = game.date || ""; 
            const dateParts = rawDate.split(" ");
            const gameDateStr = dateParts[0]; // DD.MM.YYYY
            const gameTime = dateParts[1] || ""; // HH:MM
            const parts = gameDateStr.split(".");
            const gameDateObj = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
            const shortDay = shortDays[gameDateObj.getDay()];
            
            // Формат: "12.05 (Пн) 19:00 — Название"
            let optionText = `${gameDateStr.substring(0, 5)} (${shortDay}) ${gameTime} — ${title}`;
            if (optionText.length > 100) {
                optionText = optionText.substring(0, 97) + "...";
            }

            // Telegram требует уникальные варианты ответов
            while (options.includes(optionText)) {
                optionText += " ";
                if (optionText.length > 100) {
                    optionText = optionText.substring(0, 99) + " ";
                }
            }

            options.push(optionText);
            
            if (options.length >= 9) {
                break; // Оставляем место для варианта "Пропускаю"
            }
        }

        options.push("Пропускаю неделю 😢");

        const pollQuestion = `На какие игры идем на следующей неделе?`;

        await fetch(tgUrl(env, "sendPoll"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: targetChatId,
                question: pollQuestion,
                options: JSON.stringify(options),
                is_anonymous: false,
                allows_multiple_answers: true,
                type: "regular"
            })
        });

    } catch (error) {
        console.error("Ошибка команды /pollweek:", error);
        await sendTelegramMessage(targetChatId, "❌ Произошла ошибка при создании опроса.", env);
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
        await executeLivePing(chatId, messageId, data.replace("png:", ""), callbackQuery.id, env);
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

    // КВНТРОЛЬ ЛИМИТА СТОЛА (9 ЧЕЛОВЕК)
    try {
        let totalSeats = 0;
        if (gameObject.voters) {
            for (const user of Object.values(gameObject.voters)) {
                if (user && user.count > 0) totalSeats += user.count;
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

    // АВТОПОПОЛНЕНИЕ БАЗЫ ИГРОКОВ
    try {
        const cachedTeam = await env.QUIZ_DB.get("global_team_members");
        let teamList = cachedTeam ? JSON.parse(cachedTeam) : [];
        const index = teamList.findIndex(member => member.id === userId);

        if (index === -1) {
            teamList.push({ id: userId, name: firstName, username: username });
            await env.QUIZ_DB.put("global_team_members", JSON.stringify(teamList));
        } else if (teamList[index].username !== username || teamList[index].name !== firstName) {
            teamList[index].name = firstName;
            teamList[index].username = username;
            await env.QUIZ_DB.put("global_team_members", JSON.stringify(teamList));
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
        if (todayPollId) await processReminder(todayPollId, "СЕГОДНЯ", targetChatId, env);
        if (tomorrowPollId) await processReminder(tomorrowPollId, "ЗАВТРА", targetChatId, env);

    } catch (error) {
        console.error("Сбой внутри checkAndSendReminders:", error.message);
        await sendTelegramMessage(targetChatId, `💥 Ошибка планировщика напоминаний:\n<code>${error.message}</code>`, env);
    }
}

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

// --- ТРЕКИНГ И ДОСТИЖЕНИЙ ---
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

                    const dbKey = `stats:${label}`;
                    const cachedData = await env.QUIZ_DB.get(dbKey);
                    
                    if (cachedData) {
                        const oldStats = JSON.parse(cachedData);
                        const oldGames = oldStats.games || 0;
                        const oldPoints = oldStats.points || 0;

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
                            
                            await sendTelegramMessage(targetChatId, celebrationText, env);
                        }
                    }

                    await env.QUIZ_DB.put(dbKey, JSON.stringify({
                        points: currentPoints,
                        games: currentGames,
                        rank: currentRank,
                        updatedAt: new Date().toISOString()
                    }));
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
            
            // ОПТИМИЗАЦИЯ: Читаем данные из active_game один раз
            const activeGameData = await env.QUIZ_DB.get(keyObj.name);
            if (!activeGameData) continue;

            const parsedActiveGame = JSON.parse(activeGameData);
            const fullGameObj = await env.QUIZ_DB.get(`poll:${parsedActiveGame.pollId}`);
            if (!fullGameObj) continue;

            const game = JSON.parse(fullGameObj);
            
            // Если дата или время не записались (старый опрос), проверяем по старинке
            if (game.date && game.time) {
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
            if (json_data.data && json_data.data.message === "Игра не найдена") continue;

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

                    await env.QUIZ_DB.delete(keyObj.name);

                    const position = parseInt(ourResult.place || ourResult.rank, 10) || 99;
                    const totalPoints = ourResult.total || 0;

                    const gameTitle = game.title || "Прошедший Квиз, плиз!";
                    
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
                    text += `🎖 <b>Занятое место:</b> ${position} место\n`;
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

                     const fullHtml = `<style>* { font-family: sans-serif; font-size: 14px; } table { width: 100%; border-collapse: collapse; } th, td { padding: 8px; border: 1px solid #ddd; text-align: left; } .our-team { background: #fef08a; font-weight: bold; }</style><div style="padding: 20px; background: white;"><h2>${gameTitle}</h2><table><thead><tr><th>Место</th><th>Команда</th><th>Итого</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;

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

                    let todoData = await env.QUIZ_DB.get("todo_list", { type: "json" });
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
                    
            }  
        }
    } catch (error) {
        console.error("Ошибка в функции checkLiveResults:", error.message);
    }
}

async function checkLiveResultsTest(targetChatId, env) {
    if (!env || !env.QUIZ_DB) return;
    const headers = { "User-Agent": "Mozilla/5.0" };

    try {
        // Получаем из базы список всех ключей активных игр
        const list = await env.QUIZ_DB.list({ prefix: "activetest_game:" });
        if (!list.keys || list.keys.length === 0) return; // Если активных игр нет, засыпаем
        
         // Получаем текущее точное время в Новокузнецке (Красноярск +7)
        const now = new Date();
        const localTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Krasnoyarsk" }));
        
        for (const keyObj of list.keys) {
            const gameId = keyObj.name.replace("activetest_game:", "");
            
            // ОПТИМИЗАЦИЯ: Читаем данные из active_game один раз
            const activeGameData = await env.QUIZ_DB.get(keyObj.name);
            if (!activeGameData) continue;

            const parsedActiveGame = JSON.parse(activeGameData);
            const fullGameObj = await env.QUIZ_DB.get(`poll:${parsedActiveGame.pollId}`);
            if (!fullGameObj) continue;

            const game = JSON.parse(fullGameObj);
            
            // Если дата или время не записались (старый опрос), проверяем по старинке
            if (game.date && game.time) {
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
            if (json_data.data && json_data.data.message === "Игра не найдена") continue;

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

                    await env.QUIZ_DB.delete(keyObj.name);

                    const position = parseInt(ourResult.place || ourResult.rank, 10) || 99;
                    const totalPoints = ourResult.total || 0;

                    const gameTitle = game.title || "Прошедший Квиз, плиз!";
                    
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
                    text += `🎖 <b>Занятое место:</b> ${position} место\n`;
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

                     const fullHtml = `<style>* { font-family: sans-serif; font-size: 14px; } table { width: 100%; border-collapse: collapse; } th, td { padding: 8px; border: 1px solid #ddd; text-align: left; } .our-team { background: #fef08a; font-weight: bold; }</style><div style="padding: 20px; background: white;"><h2>${gameTitle}</h2><table><thead><tr><th>Место</th><th>Команда</th><th>Итого</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;

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

                    let todoData = await env.QUIZ_DB.get("todo_list", { type: "json" });
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
                    
            }  
        }
    } catch (error) {
        console.error("Ошибка в функции checkLiveResults:", error.message);
    }
}

// --- ФУНКЦИЯ ВЫВОДА МЕНЮ ВЫБОРА ОПРОСА ДЛЯ ПИНГА ---
async function pingTeam(targetChatId, env) {

    // 1. Получаем актуальный To-Do список из базы
    const todoDataRaw = await env.QUIZ_DB.get("todo_list");
    if (!todoDataRaw) {
        return await sendTelegramMessage(env, targetChatId, "📭 Список игр пуст. Некого пинговать!");
    }

    const todoData = JSON.parse(todoDataRaw);
    const games = todoData.games || [];

    // 2. Фильтруем только АКТИВНЫЕ игры (у которых статус не "done")
    // Дополнительно можно проверять, что для игры вообще существует активный опрос
    const activeGames = games.filter(game => game.status !== "done");

    if (activeGames.length === 0) {
        return await sendTelegramMessage(env, targetChatId, "📅 Нет активных игр для напоминания.");
    }

    // 3. Строим клавиатуру только для живых игр
    const inlineKeyboard = [];

    for (const game of activeGames) {
        // Ищем соответствующий poll_id для этой игры в KV, если он хранится отдельно,
        // либо используем внутренний ID игры. 
        // Предположим, у тебя связь идет через префикс poll: или прямо по game.id:
        const pollKey = `poll:${game.id}`;
        const pollId = await env.QUIZ_DB.get(pollKey);

        // Если опрос для игры не найден или удален, можно пропустить или слать по game.id
        if (!pollId) continue; 

        inlineKeyboard.push([{
            text: `🔔 ${game.date} — ${game.title || "Квиз"}`,
            // Передаем pollId (главное, чтобы строка png:pollId не превысила 64 байта!)
            callback_data: `png:${pollId}` 
        }]);
    }

    if (inlineKeyboard.length === 0) {
        return await sendTelegramMessage(env, targetChatId, "🤷‍♂️ Активные игры есть, но опросы по ним не запущены.");
    }

    // 4. ДОБАВЛЯЕМ КНОПКУ «ОТМЕНА»
    // Используем понятный префикс, например, 'action:cancel' или просто 'cancel'
    inlineKeyboard.push([{
        text: "❌ Отмена",
        callback_data: "cmd:cancel_menu"
    }]);

    const text = "🎯 *Выбери игру, чтобы тегнуть молчунов:*";

    await fetch(tgUrl(env, "sendMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: targetChatId,
            text: text,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: inlineKeyboard }
        })
    });
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
            await sendTelegramMessage(chatId, `✅ <b>Полный сбор на игру «${game.title}»!</b> Прогульщиков нет! 🥰`, env);
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

        // ОПТИМИЗАЦИЯ: Параллельный перевод через Promise.all вместо последовательного цикла
        const [categoryRu, questionRu, correctAnswerRu, ...incorrectAnswersRu] = await Promise.all([
            translateText(questionData.category, env),
            translateText(questionData.question, env),
            translateText(questionData.correct_answer, env),
            ...questionData.incorrect_answers.map(ans => translateText(ans, env))
        ]);
        
        let answersOptions = [...incorrectAnswersRu, correctAnswerRu];

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

// Формирование текста и тихое обновление (или создание) закрепленного сообщения
async function updateTodoMessage(env) {
    const now = new Date();
    const localTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Krasnoyarsk" }));
    const year = localTime.getFullYear();
    const month = String(localTime.getMonth() + 1).padStart(2, '0');
    const currentMonthKey = `${year}-${month}`;

    const monthsRu = [
        "ЯНВАРЬ", "ФЕВРАЛЬ", "МАРТ", "АПРЕЛЬ", "МАЙ", "ИЮНЬ",
        "ИЮЛЬ", "АВГУСТ", "СЕНТЯБРЬ", "ОКТЯБРЬ", "НОЯБРЬ", "ДЕКАБРЬ"
    ];
    const monthName = monthsRu[localTime.getMonth()];

    let todoData = await env.QUIZ_DB.get("todo_list", { type: "json" });
    if (!todoData) {
        todoData = { pinned_message_id: null, current_month: currentMonthKey, games: [] };
    }

    if (todoData.current_month !== currentMonthKey) {
        todoData.pinned_message_id = null;
        todoData.current_month = currentMonthKey;
        todoData.games = todoData.games.filter(g => {
            const gParts = g.raw_date.split('.');
            if (gParts.length === 3) {
                const formattedMonth = String(gParts[1]).padStart(2, '0');
                return `${gParts[2]}-${formattedMonth}` >= currentMonthKey;
            }
            return true;
        });
    }

    // Собираем текст в безопасном HTML формате
    let messageText = `📌 <b>СПИСОК ЗАДАЧ НА ${monthName} ${year}</b>\n\n`;
    
    if (todoData.games.length === 0) {
        messageText += "⏳ Задач пока нет. Запустите /poll для добавления игры!";
    } else {
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

            // Экранируем символы < и > в названии игры для безопасности HTML
            const cleanTitle = game.title.replace(/</g, "&lt;").replace(/>/g, "&gt;");

            messageText += `${statusEmoji} ${index + 1}. <b>${game.day_of_week}</b>, ${game.date_str}: #${game.id} [${cleanTitle}] — <i>${statusText}</i>\n`;
        });
    }

    messageText += `\n<i>🔄 Обновлено автоматически в ${String(localTime.getHours()).padStart(2, '0')}:${String(localTime.getMinutes()).padStart(2, '0')}</i>`;

    const chatId = env.CHAT_ID;
    
    if (todoData.pinned_message_id) {
        try {
            await fetch(tgUrl(env, "editMessageText"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: todoData.pinned_message_id,
                    text: messageText,
                    parse_mode: "HTML"
                })
            });
        } catch (e) {
            console.error("Ошибка обновления закрепленного сообщения:", e);
            todoData.pinned_message_id = null; 
        }
    }

    if (!todoData.pinned_message_id) {
        try {
            const sendRes = await fetch(tgUrl(env, "sendMessage"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: messageText,
                    parse_mode: "HTML"
                })
            });
            const sendData = await sendRes.json();
            
            if (sendData.ok) {
                todoData.pinned_message_id = sendData.result.message_id;
                
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

    await env.QUIZ_DB.put("todo_list", JSON.stringify(todoData));
}

function parseGameDate(rawDate) {
    let dayOfWeek = "День игры";
    let dateStr = rawDate;

    if (!rawDate) return { dayOfWeek, dateStr };

    const parts = rawDate.split('.'); // "18.06.2026"
    if (parts.length === 3) {
        const day = parseInt(parts[0], 10);
        const monthIdx = parseInt(parts[1], 10) - 1;
        const year = parseInt(parts[2], 10);

        // Создаем дату с явным смещением, чтобы избежать сдвига дня недели из-за UTC
        const date = new Date(year, monthIdx, day, 12, 0, 0); 
        
        const months = [
            "января", "февраля", "марта", "апреля", "мая", "июня",
            "июля", "августа", "сентября", "октября", "ноября", "декабря"
        ];

        dayOfWeek = DAYS_OF_WEEK[date.getDay()];
        dateStr = `${day} ${months[monthIdx]}`;
    }

    return { dayOfWeek, dateStr };
}

// Автоматическое добавление игры в To-Do при вызове /poll
async function addGameToTodo(gameId, gameTitle, rawDate, env) {
    let todoData = await env.QUIZ_DB.get("todo_list", { type: "json" });
    if (!todoData) {
        const localTime = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Krasnoyarsk" }));
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