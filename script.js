const languageNames = {
  python: "Python",
  cpp: "C++",
  java: "Java",
};

const taskTypeNames = {
  gaps: "Код с пропусками",
  bugs: "Зашумленный код",
  reorder: "Восстановить порядок строк",
  explain: "Объяснение кода",
  output: "Определить результат выполнения",
  complete: "Дополнить функцию",
  extra: "Найти лишний фрагмент",
  match: "Сопоставить код и описание",
};

const levelNames = {
  easy: "Легкая",
  medium: "Средняя",
  hard: "Сложная",
};

const levelHints = {
  easy: "подходит для первичной проверки понимания темы",
  medium: "требует уверенного чтения кода и понимания алгоритма",
  hard: "подходит для контрольной работы или сильной учебной группы",
};

const MAX_SOURCE_CODE_LENGTH = 80000;

const languageSelect = document.querySelector("#languageSelect");
const taskTypeSelect = document.querySelector("#taskTypeSelect");
const levelSelect = document.querySelector("#levelSelect");
const topicInput = document.querySelector("#topicInput");
const countInput = document.querySelector("#countInput");
const sourceCode = document.querySelector("#sourceCode");
const languageBadge = document.querySelector("#languageBadge");
const resultPreview = document.querySelector("#resultPreview");
const generateAiButton = document.querySelector("#generateAiButton");
const generationStatus = document.querySelector("#generationStatus");

let currentResult = null;

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clampCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return 1;
  }
  return Math.min(Math.max(parsed, 1), 12);
}

function buildTaskTitle(taskType, topic, language) {
  return `${taskType}: ${topic} (${language})`;
}

function renderResult({
  title,
  language,
  topic,
  level,
  levelKey,
  count,
  condition,
  originalCode,
  studentMaterial,
  correctAnswer,
  explanation,
  skills = [],
  changes = [],
  model,
}) {
  currentResult = {
    title,
    language,
    topic,
    level,
    count,
    condition,
    original_code: originalCode,
    student_material: studentMaterial,
    correct_answer: correctAnswer,
    explanation,
    skills,
    changes,
    model: model || "не указан",
  };

  resultPreview.innerHTML = `
    ${model ? `<p class="model-note">Источник генерации: ${escapeHtml(model)}</p>` : ""}
    <div class="result-title">
      <p>Материал для преподавателя</p>
      <h3>${escapeHtml(title)}</h3>
    </div>
    <dl class="meta-grid">
      <div>
        <dt>Язык</dt>
        <dd>${language}</dd>
      </div>
      <div>
        <dt>Тема</dt>
        <dd>${escapeHtml(topic)}</dd>
      </div>
      <div>
        <dt>Сложность</dt>
        <dd>${level}</dd>
      </div>
      <div>
        <dt>Элементов</dt>
        <dd>${count}</dd>
      </div>
    </dl>
    <div class="task-block">
      <h4>1. Условие задачи</h4>
      <p>${escapeHtml(condition)}</p>
    </div>
    <div class="task-block">
      <h4>2. Исходный код преподавателя</h4>
      <pre><code>${escapeHtml(originalCode)}</code></pre>
    </div>
    <div class="task-block">
      <div class="task-block-heading">
        <h4>3. Код / материал для студента</h4>
        <button class="copy-button" type="button" data-action="copy-student" title="Скопировать материал">
          <span class="copy-icon" aria-hidden="true"></span>
          <span class="copy-label">Скопировать</span>
        </button>
      </div>
      <pre><code>${escapeHtml(studentMaterial)}</code></pre>
    </div>
    <div class="task-block answer-block">
      <h4>4. Правильный ответ</h4>
      <pre><code>${escapeHtml(correctAnswer)}</code></pre>
    </div>
    <div class="task-block explanation-block">
      <h4>5. Пояснение</h4>
      <p>${escapeHtml(explanation)}</p>
      <p class="level-note">Уровень сложности: ${level.toLowerCase()}, ${levelHints[levelKey]}.</p>
    </div>
    <div class="task-block">
      <h4>6. Проверяемые навыки</h4>
      <ul class="plain-list">
        ${skills.map((skill) => `<li>${escapeHtml(skill)}</li>`).join("")}
      </ul>
    </div>
    <div class="task-block">
      <h4>7. Список изменений</h4>
      <ul class="plain-list">
        ${changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/\n|;/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function getCurrentParams() {
  const languageKey = languageSelect.value;
  const taskTypeKey = taskTypeSelect.value;
  const levelKey = levelSelect.value;
  return {
    languageKey,
    taskTypeKey,
    levelKey,
    language: languageNames[languageKey],
    taskType: taskTypeNames[taskTypeKey],
    level: levelNames[levelKey],
    topic: topicInput.value.trim() || "не указана",
    count: clampCount(countInput.value),
    sourceCode: sourceCode.value.trim(),
  };
}

async function generateWithAi() {
  const params = getCurrentParams();
  const validationError = validateClientParams(params);
  if (validationError) {
    showInputError(validationError);
    return;
  }
  currentResult = { model: "pending" };
  generateAiButton.disabled = true;
  generationStatus.textContent = "Генерация";

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        language: params.language,
        taskType: params.taskType,
        topic: params.topic,
        level: params.level,
        count: params.count,
        sourceCode: params.sourceCode,
        title: buildTaskTitle(params.taskType, params.topic, params.language),
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Не удалось сформировать задание");
    }

    const task = data.task;
    generationStatus.textContent = "Сгенерировано ИИ";
    renderResult({
      title: task.title,
      language: params.language,
      topic: params.topic,
      level: params.level,
      levelKey: params.levelKey,
      count: params.count,
      condition: task.condition,
      originalCode: task.original_code,
      studentMaterial: task.student_material,
      correctAnswer: task.correct_answer,
      explanation: task.explanation,
      skills: normalizeList(task.skills),
      changes: normalizeList(task.changes),
      model: data.model,
    });
  } catch (error) {
    generationStatus.textContent = "Ошибка";
    resultPreview.innerHTML = `
      <div class="error-message">
        <strong>Не удалось выполнить генерацию задания.</strong><br />
        ${escapeHtml(error.message)}
      </div>
    `;
  } finally {
    generateAiButton.disabled = false;
  }
}

function validateClientParams(params) {
  if (!params.sourceCode) {
    return "Вставьте правильный исходный код преподавателя";
  }
  if (params.sourceCode.length > MAX_SOURCE_CODE_LENGTH) {
    return `Исходный код слишком большой: максимум ${MAX_SOURCE_CODE_LENGTH} символов`;
  }
  if (!params.topic || params.topic === "не указана") {
    return "Укажите тему задания, например: циклы, массивы, функции";
  }
  return "";
}

function showInputError(message) {
  generationStatus.textContent = "Нет кода";
  resultPreview.innerHTML = `
    <div class="error-message">
      <strong>${escapeHtml(message)}</strong><br />
      Преподаватель сначала дает рабочий код, а инструмент уже преобразует его в оценочный материал.
    </div>
  `;
  currentResult = null;
}

function updateLanguage() {
  const selectedLanguage = languageSelect.value;
  languageBadge.textContent = languageNames[selectedLanguage];
  resetCurrentResult();
}

function resetCurrentResult() {
  currentResult = null;
  generationStatus.textContent = "Ожидание";
  resultPreview.innerHTML = `
    <div class="note">
      Выберите параметры задания, вставьте правильный исходный код и нажмите «Сгенерировать задание».
    </div>
  `;
}

async function copyStudentMaterial(button) {
  if (!currentResult?.student_material) {
    generationStatus.textContent = "Нет материала";
    return;
  }

  try {
    await navigator.clipboard.writeText(currentResult.student_material);
    generationStatus.textContent = "Скопировано";
    button?.classList.add("is-copied");
    const label = button?.querySelector(".copy-label");
    if (label) {
      label.textContent = "Скопировано";
      setTimeout(() => {
        label.textContent = "Скопировать";
        button.classList.remove("is-copied");
      }, 1400);
    }
  } catch {
    generationStatus.textContent = "Ошибка копирования";
  }
}

languageSelect.addEventListener("change", updateLanguage);
taskTypeSelect.addEventListener("change", resetCurrentResult);
levelSelect.addEventListener("change", resetCurrentResult);
topicInput.addEventListener("input", resetCurrentResult);
countInput.addEventListener("input", resetCurrentResult);
sourceCode.addEventListener("input", resetCurrentResult);
generateAiButton.addEventListener("click", generateWithAi);
resultPreview.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }
  if (button.dataset.action === "copy-student") {
    copyStudentMaterial(button);
  }
});

updateLanguage();
