import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const ROOT_DIR = process.cwd();
loadEnvFile();

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const EXTERNAL_SERVICE_API_URL = process.env.OPENROUTER_API_URL || process.env.EXTERNAL_SERVICE_API_URL || "https://openrouter.ai/api/v1";
const EXTERNAL_SERVICE_TIMEOUT_MS = 8_000;
const MAX_SOURCE_CODE_LENGTH = 80_000;

const ALLOWED_LANGUAGES = new Set(["Python", "C++", "Java"]);
const ALLOWED_TASK_TYPES = new Set([
  "Код с пропусками",
  "Зашумленный код",
  "Восстановить порядок строк",
  "Объяснение кода",
  "Определить результат выполнения",
  "Дополнить функцию",
  "Найти лишний фрагмент",
  "Сопоставить код и описание",
]);
const ALLOWED_LEVELS = new Set(["Легкая", "Средняя", "Сложная"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const preferredModels = [
  "qwen/qwen3-coder",
  "qwen/qwen3",
  "deepseek/deepseek-chat-v3",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-r1",
  "meta-llama/llama-3.3",
  "mistralai/mistral",
  "moonshotai/kimi",
  "google/gemini",
];

function loadEnvFile() {
  const envPath = join(ROOT_DIR, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 120_000) {
      throw new Error("Слишком большой запрос");
    }
  }
  return JSON.parse(body || "{}");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(resolve(ROOT_DIR, "." + requestedPath));

  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function getAvailableModels(apiKey) {
  try {
    const response = await fetch(`${EXTERNAL_SERVICE_API_URL}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`models request failed: ${response.status}`);
    }

    const payload = await response.json();
    const models = Array.isArray(payload.data) ? payload.data : [];
    return models.map((model) => model.id).filter((id) => typeof id === "string").sort((a, b) => modelScore(a) - modelScore(b));
  } catch {
    return [];
  }
}

function modelScore(modelId) {
  const normalized = modelId.toLowerCase();
  const foundIndex = preferredModels.findIndex((item) => normalized.includes(item));
  return foundIndex === -1 ? preferredModels.length : foundIndex;
}

function buildPrompt(payload) {
  const schema = {
    title: "Название задания",
    condition: "Условие для студента",
    original_code: "Исходный код преподавателя",
    student_material: "Измененный код или материал для студента",
    correct_answer: "Правильный ответ для преподавателя",
    explanation: "Пояснение, что проверяет задание",
    skills: ["Проверяемый навык 1", "Проверяемый навык 2"],
    changes: ["Что было изменено в исходном коде"],
    gap_answers: ["Ответ для первого пропуска", "Ответ для второго пропуска"],
    difficulty: "Легкая | Средняя | Сложная",
  };

  const modeRules = getModeRules(payload);

  return [
    {
      role: "system",
      content:
        "Сформируй учебный оценочный материал по программированию на основе корректного исходного кода. Ответ должен быть только валидным JSON без markdown и пояснений вне JSON. Все поля схемы обязательны и не должны быть пустыми.",
    },
    {
      role: "user",
      content: `Сформируй задание по программированию.

Верни JSON строго по схеме:
${JSON.stringify(schema, null, 2)}

Параметры:
- Язык: ${payload.language}
- Тип задания: ${payload.taskType}
- Тема: ${payload.topic}
- Сложность: ${payload.level}
- Количество элементов задания: ${payload.count}

Исходный правильный код:
\`\`\`${payload.language}
${payload.sourceCode}
\`\`\`

Контекст:
- Пользователь приложения - преподаватель.
- Студент получает только condition и student_material.
- correct_answer, explanation, skills и changes нужны преподавателю для проверки.

Требования:
- Ответ должен быть одним JSON-объектом.
- Запрещены значения undefined, null и пустые строки.
- student_material должен соответствовать выбранному типу задания.
- correct_answer должен помогать преподавателю быстро проверить студента.
- Для типа "Зашумленный код" внеси осмысленные ошибки, добавь лишние фрагменты и перечисли исправления.
- Для остальных типов преобразуй исходный код в соответствующее учебное задание.
- changes должен быть списком конкретных изменений относительно исходного правильного кода.
- skills должен быть списком проверяемых навыков студента.
- Для C++ и Java сохраняй реалистичный синтаксис.
- Не добавляй несуществующие внешние библиотеки.

Правила для выбранного типа:
${modeRules}`,
    },
  ];
}

function getModeRules(payload) {
  if (payload.taskType === "Сопоставить код и описание") {
    return `- Это режим "Сопоставить код и описание".
- original_code обязан быть точной копией исходного кода преподавателя.
- Выбери несколько осмысленных фрагментов исходного кода: ввод, условие, цикл, вычисление, обновление переменной, вывод, обработку ошибки.
- В student_material дай два списка: фрагменты кода с буквами и описания с номерами в перемешанном порядке.
- Описания должны объяснять смысл фрагмента, а не просто пересказывать синтаксис.
- Не добавляй фрагменты, которых нет в исходном коде.
- correct_answer должен содержать точный ключ соответствий, например "A-3, B-1".
- changes должен указать, что код разобран на фрагменты и описания.`;
  }

  if (payload.taskType === "Найти лишний фрагмент") {
    return `- Это режим "Найти лишний фрагмент".
- original_code обязан быть точной копией исходного кода преподавателя.
- В student_material добавь один или несколько лишних фрагментов, которых не было в исходном коде.
- Лишний фрагмент должен выглядеть правдоподобно: неиспользуемая переменная, лишнее вычисление, дублирующая проверка или диагностическая строка.
- Не ломай синтаксис программы и не меняй пользовательские текстовые сообщения.
- Не добавляй очевидный мусор вроде случайных слов, бессмысленных символов или комментария "лишний код".
- correct_answer должен точно указать, какой фрагмент лишний и почему его можно удалить.
- changes должен перечислить добавленные лишние фрагменты.`;
  }

  if (payload.taskType === "Дополнить функцию") {
    return `- Это режим "Дополнить функцию".
- original_code обязан быть точной копией исходного кода преподавателя.
- В student_material нужно оставить сигнатуру функции, окружающий код и понятный маркер недостающего фрагмента.
- Удаляй смысловую часть алгоритма: инициализацию, цикл, условие, накопление результата или return, а не только скобку, двоеточие или одну служебную строку.
- Если отдельной функции нет, можно удалить логически цельный фрагмент внутри main/основного блока и назвать задание "Дополните недостающий фрагмент алгоритма".
- condition должен объяснять ожидаемое поведение, чтобы студент мог восстановить код по смыслу.
- correct_answer должен содержать полный недостающий фрагмент и, если нужно, полный правильный код.
- changes должен перечислять, какой фрагмент был удален.`;
  }

  if (payload.taskType === "Определить результат выполнения") {
    return `- Это режим "Определить результат выполнения".
- original_code обязан быть точной копией исходного кода преподавателя.
- student_material должен содержать исходный код без изменений.
- Если в коде есть ввод с клавиатуры, обязательно добавь конкретные входные данные для трассировки.
- Не проси определить вывод интерактивной программы без заданных входных данных.
- condition должен явно говорить, учитывать ли приглашения input() как часть вывода. Если сомневаешься, проверяй только строки, напечатанные print/cout/System.out.println.
- correct_answer должен содержать точный ожидаемый вывод и краткую трассировку ключевых переменных.
- changes должен указать, что исходный код не изменялся, а к заданию добавлены входные данные или требование трассировки.`;
  }

  if (payload.taskType === "Объяснение кода") {
    return `- Это режим "Объяснение кода".
- original_code обязан быть точной копией исходного кода преподавателя.
- student_material должен содержать исходный код без изменений и список конкретных вопросов для студента.
- Вопросы должны проверять понимание программы: назначение, входные данные, выходные данные, переменные, ключевые шаги алгоритма, условия, циклы, функции, исключения и крайние случаи.
- Не проси студента переписывать код, исправлять синтаксис или угадывать стиль оформления.
- Не давай общую формулировку вроде "объясните код" без конкретных проверяемых пунктов.
- Для интерактивного кода с input() обязательно спроси, какие данные вводит пользователь и какие сообщения/результаты выводятся.
- correct_answer должен быть эталонным ответом или рубрикой проверки для преподавателя: что программа делает, как идет выполнение, какие конструкции используются, какие ошибки в понимании считать существенными.
- changes должен явно указать, что исходный код не изменялся, а был преобразован в задание на чтение и объяснение.`;
  }

  if (payload.taskType === "Восстановить порядок строк") {
    return `- Это режим "Восстановить порядок строк".
- original_code обязан быть точной копией исходного кода преподавателя.
- Выбери логически связанный фрагмент программы: инициализация, цикл, условие, вычисление, вывод.
- Не перемешивай весь файл целиком, если это ломает понимание структуры.
- В student_material дай перемешанные строки с номерами или буквами.
- Сохраняй отступы как часть строк, чтобы студент мог восстановить структуру блока.
- correct_answer должен содержать правильный порядок строк.
- changes должен объяснять, какой блок был перемешан и какие навыки проверяются.`;
  }

  if (payload.taskType === "Зашумленный код") {
    return `- Это режим "Зашумленный код".
- original_code обязан быть точной копией исходного кода преподавателя.
- В student_material нужно внести около ${payload.count} осмысленных изменений.
- Основная часть изменений должна проверять знания программирования: условия, операции, переменные, типы, циклы, обработку ошибок, крайние случаи.
- Не делай задание только из удаления двоеточий, скобок, кавычек, точек с запятой или фигурных скобок.
- Не меняй пользовательские текстовые строки и сообщения программы ради сложности.
- Не заменяй русский текст на английский и не проверяй знание языка интерфейса.
- Добавь хотя бы один "шумовой" фрагмент, если это уместно: лишнее присваивание, неиспользуемая переменная, лишняя проверка или лишний вывод.
- correct_answer должен содержать правильный исходный код и краткий ключ исправлений.
- changes должен перечислять только реальные изменения в student_material.`;
  }

  if (payload.taskType !== "Код с пропусками") {
    return "- Следуй выбранному типу задания и не меняй original_code.";
  }

  return `- Это режим "Код с пропусками".
- original_code обязан быть точной копией исходного кода преподавателя.
- В student_material должно быть ровно ${payload.count} маркеров _____.
- Каждый маркер _____ заменяет ровно один осмысленный фрагмент кода.
- Не скрывай только двоеточия, скобки, кавычки, запятые, точки с запятой или фигурные скобки.
- Не делай пропуском весь операторный каркас вроде "while True:" или "try:"; лучше скрывай условие, выражение, переменную, оператор, аргумент функции, значение, индекс, часть вычисления.
- Не меняй пользовательские текстовые строки и сообщения программы.
- correct_answer должен содержать ровно ${payload.count} пронумерованных строк в формате "1. ответ", "2. ответ".
- gap_answers должен быть массивом из ровно ${payload.count} строк, где каждый элемент является точной подстановкой для соответствующего маркера _____.
- Нельзя писать в correct_answer "оставлено без изменений", "без изменений", "не изменено" или похожий текст.
- changes должен содержать ровно ${payload.count} пунктов, каждый пункт должен описывать один реально замененный фрагмент.
- Если пропуск находится внутри массива, списка или инициализатора, answer должен быть только скрытым элементом, а не всей структурой.
- Задание должно проверять знания программирования: условия, циклы, переменные, выражения, типы, функции, ввод/вывод, обработку ошибок.`;
}

function parseModelJson(content) {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Внешний генератор вернул ответ не в формате JSON");
    }
    return JSON.parse(match[0]);
  }
}

function normalizeGeneratedTask(task, requestContext) {
  const normalized = {
    title: cleanField(task.title) || requestContext.title,
    condition: cleanField(task.condition),
    original_code: cleanField(task.original_code) || requestContext.sourceCode,
    student_material: cleanField(task.student_material),
    correct_answer: cleanField(task.correct_answer),
    explanation: cleanField(task.explanation),
    skills: cleanList(task.skills),
    changes: cleanList(task.changes),
    gap_answers: cleanList(task.gap_answers),
    difficulty: cleanField(task.difficulty) || requestContext.level,
  };

  const missingFields = [
    "title",
    "condition",
    "original_code",
    "student_material",
    "correct_answer",
    "explanation",
    "skills",
    "changes",
    "difficulty",
  ].filter((field) => {
    const value = normalized[field];
    return Array.isArray(value) ? value.length === 0 : !value;
  });

  if (missingFields.length) {
    throw new Error(`Неполный JSON от внешнего генератора, нет полей: ${missingFields.join(", ")}`);
  }

  validateGeneratedTask(normalized, requestContext);

  return normalized;
}

function validateGeneratedTask(task, requestContext) {
  if (task.original_code !== requestContext.sourceCode) {
    task.original_code = requestContext.sourceCode;
  }

  if (requestContext.taskType === "Код с пропусками") {
    validateGapTask(task, requestContext);
  }

  if (requestContext.taskType === "Зашумленный код") {
    validateNoisyTask(task, requestContext);
  }

  if (requestContext.taskType === "Объяснение кода") {
    validateExplanationTask(task, requestContext);
  }

  if (requestContext.taskType === "Определить результат выполнения") {
    validateOutputTask(task, requestContext);
  }

  if (requestContext.taskType === "Дополнить функцию") {
    validateCompleteTask(task, requestContext);
  }

  if (requestContext.taskType === "Найти лишний фрагмент") {
    validateExtraTask(task, requestContext);
  }

  if (requestContext.taskType === "Сопоставить код и описание") {
    validateMatchTask(task);
  }
}

function validateExplanationTask(task, requestContext) {
  if (!task.student_material.includes(requestContext.sourceCode)) {
    throw new Error("Материал для объяснения должен содержать исходный код без изменений");
  }

  const questionSignals = countOccurrences(task.student_material, "?") + countOccurrences(task.student_material, "Вопрос");
  if (questionSignals < 2) {
    throw new Error("Материал для объяснения содержит слишком мало конкретных вопросов");
  }

  if (task.correct_answer.length < 180) {
    throw new Error("Правильный ответ для объяснения слишком короткий и не похож на рубрику");
  }

  if (normalizeCode(task.original_code) !== normalizeCode(requestContext.sourceCode)) {
    throw new Error("Исходный код был изменен в режиме объяснения");
  }
}

function validateOutputTask(task, requestContext) {
  if (!task.student_material.includes(requestContext.sourceCode)) {
    throw new Error("Материал для определения результата должен содержать исходный код без изменений");
  }

  if (/\binput\s*\(/.test(requestContext.sourceCode) && !/входн|данн|input|пользователь вводит/i.test(task.student_material)) {
    throw new Error("Для интерактивной программы не заданы входные данные");
  }

  if (!/вывод|результат|output|печата/i.test(task.correct_answer) || task.correct_answer.length < 40) {
    throw new Error("Правильный ответ для вывода слишком короткий или неконкретный");
  }
}

function validateCompleteTask(task, requestContext) {
  if (normalizeCode(task.student_material) === normalizeCode(requestContext.sourceCode)) {
    throw new Error("В режиме дополнения код для студента не должен совпадать с исходным");
  }

  if (!/допишите|_____|пропущен|missing/i.test(task.student_material)) {
    throw new Error("В коде для студента нет явного маркера недостающего фрагмента");
  }

  if (task.correct_answer.length < 80) {
    throw new Error("Правильный ответ для дополнения слишком короткий");
  }
}

function validateExtraTask(task, requestContext) {
  if (normalizeCode(task.student_material) === normalizeCode(requestContext.sourceCode)) {
    throw new Error("В режиме поиска лишнего фрагмента код должен отличаться от исходного");
  }

  if (changedUserText(task.student_material, requestContext.sourceCode)) {
    throw new Error("Лишний фрагмент не должен менять пользовательские текстовые строки");
  }

  if (!/лишн|удал|неиспольз|дублир/i.test(task.correct_answer + " " + task.changes.join(" "))) {
    throw new Error("Ответ не объясняет, какой фрагмент является лишним");
  }
}

function validateMatchTask(task) {
  if (!/[A-ZА-Я]\s*[).:-]/.test(task.student_material) || !/\d+\s*[).:-]/.test(task.student_material)) {
    throw new Error("Материал для сопоставления должен содержать фрагменты с буквами и описания с номерами");
  }

  if (!/[A-ZА-Я]\s*[-—]\s*\d+/.test(task.correct_answer)) {
    throw new Error("Правильный ответ для сопоставления должен содержать ключ вида A-1");
  }
}

function validateNoisyTask(task, requestContext) {
  if (normalizeCode(task.student_material) === normalizeCode(requestContext.sourceCode)) {
    throw new Error("Зашумленный код не отличается от исходного");
  }

  if (hasOnlyPunctuationNoise(task.changes)) {
    throw new Error("Зашумление состоит только из синтаксической пунктуации");
  }

  if (changedUserText(task.student_material, requestContext.sourceCode)) {
    throw new Error("Зашумленный код меняет пользовательские текстовые строки");
  }
}

function hasOnlyPunctuationNoise(changes) {
  const text = changes.join(" ").toLowerCase();
  const punctuationWords = ["двоеточ", "скоб", "кавыч", "точк", "запят", "semicolon", "brace"];
  const meaningfulWords = ["услов", "операц", "перем", "тип", "цикл", "исключ", "значен", "накоп", "делени", "выраж"];
  return punctuationWords.some((word) => text.includes(word)) && !meaningfulWords.some((word) => text.includes(word));
}

function changedUserText(studentMaterial, originalCode) {
  const originalStrings = extractStringLiterals(originalCode);
  const studentStrings = new Set(extractStringLiterals(studentMaterial));
  return originalStrings.some((value) => !studentStrings.has(value));
}

function extractStringLiterals(code) {
  return [...String(code).matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g)].map(
    (match) => match[0],
  );
}

function validateGapTask(task, requestContext) {
  const expectedCount = Number.parseInt(requestContext.count, 10);
  const gapCount = countOccurrences(task.student_material, "_____");
  if (gapCount !== expectedCount) {
    throw new Error(`В режиме пропусков ожидалось ${expectedCount} маркеров _____, получено ${gapCount}`);
  }

  const answers = task.gap_answers.length ? task.gap_answers : parseNumberedAnswers(task.correct_answer);
  if (answers.length !== expectedCount) {
    throw new Error(`В correct_answer должно быть ${expectedCount} пронумерованных ответов, получено ${answers.length}`);
  }
  task.gap_answers = answers;
  task.correct_answer = formatGapAnswer(answers, task.correct_answer);

  if (task.changes.length !== expectedCount) {
    throw new Error(`В changes должно быть ${expectedCount} пунктов, получено ${task.changes.length}`);
  }

  const badAnswerPattern = /оставлен|оставлено|без изменений|не измен/i;
  if (answers.some((answer) => badAnswerPattern.test(answer))) {
    throw new Error("correct_answer содержит пункт без реального ответа на пропуск");
  }

  const punctuationOnly = /^[\s:;,.()[\]{}'"+\-*/=<>!]+$/;
  if (answers.some((answer) => punctuationOnly.test(answer))) {
    throw new Error("Один из пропусков скрывает только пунктуацию или служебные символы");
  }

  const restored = restoreGaps(task.student_material, answers);
  if (normalizeCode(restored) !== normalizeCode(requestContext.sourceCode)) {
    throw new Error("Ответы на пропуски не восстанавливают исходный код");
  }

  if (hasInvalidInitializerAnswer(task.student_material, answers)) {
    throw new Error("Ответ для пропуска внутри массива/списка содержит всю структуру вместо скрытого элемента");
  }
}

function countOccurrences(value, needle) {
  return (String(value).match(new RegExp(escapeRegExp(needle), "g")) || []).length;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseNumberedAnswers(value) {
  return String(value)
    .split(/\r?\n|;/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\d+[\).\:-]\s*(.+)$/);
      return match ? match[1].trim() : "";
    })
    .filter(Boolean);
}

function formatGapAnswer(answers, existingAnswer) {
  const existing = String(existingAnswer || "");
  const hasNumberedLines = parseNumberedAnswers(existing).length === answers.length;
  if (hasNumberedLines) {
    return existing;
  }
  return answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n");
}

function hasInvalidInitializerAnswer(studentMaterial, answers) {
  const hasInitializerGap = /[{\[]\s*_____|_____\s*[,}\]]/.test(studentMaterial);
  if (!hasInitializerGap) {
    return false;
  }
  return answers.some((answer) => /[{\[]/.test(answer) && /[}\]]/.test(answer));
}

function restoreGaps(studentMaterial, answers) {
  let index = 0;
  return studentMaterial.replace(/_____/g, () => answers[index++] ?? "_____");
}

function normalizeCode(value) {
  return String(value)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .trim();
}

function cleanField(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }
  const text = String(value).trim();
  if (!text || text === "undefined" || text === "null") {
    return "";
  }
  return text;
}

function cleanList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/\n|;/);
  return values.map((item) => cleanField(item)).filter(Boolean);
}

async function callExternalGenerator(apiKey, model, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTERNAL_SERVICE_TIMEOUT_MS);
  const response = await fetch(`${EXTERNAL_SERVICE_API_URL}/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost",
      "X-Title": "Educational Task Generator",
    },
    body: JSON.stringify({
      model,
      messages: buildPrompt(payload),
      temperature: 0.35,
      max_tokens: 2200,
      response_format: { type: "json_object" },
    }),
  }).finally(() => clearTimeout(timeout));

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Внешний сервис вернул ошибку ${response.status}: ${responseText.slice(0, 180)}`);
  }

  const data = JSON.parse(responseText);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Внешний генератор вернул пустой ответ");
  }

  return normalizeGeneratedTask(parseModelJson(content), payload);
}

async function handleGenerate(req, res) {
  try {
    const payload = validateGeneratePayload(await readJsonBody(req));
    const attempted = [];
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.EXTERNAL_SERVICE_API_KEY || "";
    const hasApiKey = apiKey && !apiKey.includes("your_external_service_key_here") && !apiKey.includes("your_openrouter_key_here") && !apiKey.includes("your_openrouter_api_key");

    if (!hasApiKey) {
      sendJson(res, 503, {
        error: "Внешний ИИ-сервис не настроен. Укажите OPENROUTER_API_KEY в файле .env",
        attempted,
      });
      return;
    }

    const models = await getAvailableModels(apiKey);
    const candidates = models.length ? models.slice(0, 6) : preferredModels.slice(0, 6);

    for (const model of candidates) {
      try {
        const task = await callExternalGenerator(apiKey, model, payload);
        sendJson(res, 200, {
          provider: "openrouter",
          model,
          attempted,
          task,
        });
        return;
      } catch (error) {
        attempted.push({
          model,
          error: error.message,
        });
        if (isExternalServiceLimit(error.message)) {
          break;
        }
      }
    }

    sendJson(res, 502, {
      error: "Внешний ИИ-сервис не смог сгенерировать задание. Попробуйте другой код или повторите запрос позже",
      attempted,
    });
  } catch (error) {
    sendJson(res, 400, {
      error: error.message || "Не удалось обработать запрос",
    });
  }
}

function validateGeneratePayload(rawPayload) {
  const payload = {
    language: cleanField(rawPayload.language),
    taskType: cleanField(rawPayload.taskType),
    topic: cleanField(rawPayload.topic) || "не указана",
    level: cleanField(rawPayload.level),
    count: Number.parseInt(rawPayload.count, 10),
    sourceCode: String(rawPayload.sourceCode || "").replace(/\r\n/g, "\n").trim(),
    title: cleanField(rawPayload.title),
  };

  if (!ALLOWED_LANGUAGES.has(payload.language)) {
    throw new Error("Выберите поддерживаемый язык: Python, C++ или Java");
  }

  if (!ALLOWED_TASK_TYPES.has(payload.taskType)) {
    throw new Error("Выберите поддерживаемый тип задания");
  }

  if (!ALLOWED_LEVELS.has(payload.level)) {
    throw new Error("Выберите корректный уровень сложности");
  }

  if (!Number.isFinite(payload.count)) {
    payload.count = 1;
  }
  payload.count = Math.min(Math.max(payload.count, 1), 12);

  if (!payload.sourceCode) {
    throw new Error("Вставьте правильный исходный код преподавателя");
  }

  if (payload.sourceCode.length > MAX_SOURCE_CODE_LENGTH) {
    throw new Error(`Исходный код слишком большой: максимум ${MAX_SOURCE_CODE_LENGTH} символов`);
  }

  if (payload.sourceCode.split(/\r?\n/).filter((line) => line.trim()).length < 1) {
    throw new Error("Исходный код должен содержать хотя бы одну непустую строку");
  }

  if (!looksLikeSelectedLanguage(payload.sourceCode, payload.language)) {
    throw new Error(`Код не похож на выбранный язык ${payload.language}. Проверьте выбор языка или вставленный код`);
  }

  payload.title = payload.title || `${payload.taskType}: ${payload.topic} (${payload.language})`;
  return payload;
}

function looksLikeSelectedLanguage(sourceCode, language) {
  const code = sourceCode.trim();
  if (language === "Python") {
    return !/#include|using namespace|public\s+class|System\.out\.println|;\s*$/m.test(code);
  }
  if (language === "C++") {
    return /#include|using namespace|std::|cout|cin|int\s+main\s*\(/.test(code);
  }
  if (language === "Java") {
    return /public\s+class|class\s+\w+|System\.out\.println|public\s+static\s+void\s+main/.test(code);
  }
  return false;
}

function isExternalServiceLimit(message) {
  const text = String(message).toLowerCase();
  return text.includes("rate limit exceeded") || text.includes("too many requests");
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/generate") {
    await handleGenerate(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`App is running at http://127.0.0.1:${PORT}`);
});
