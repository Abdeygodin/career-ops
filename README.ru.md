# Career-Ops — форк с веб-интерфейсом и поддержкой российского рынка

[English](README.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [한국어](README.ko-KR.md) | [日本語](README.ja.md) | [简体中文](README.cn.md) | [繁體中文](README.zh-TW.md) | [Українська](README.ua.md) | [Русский](README.ru.md)

> _Форк [santifer/career-ops](https://github.com/santifer/career-ops) — полноценная платформа поиска работы с браузерным интерфейсом, локальным ИИ (Ollama) и прямыми сканерами российских площадок._

[![Claude Code](https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white)](https://claude.ai)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org)
[![Ollama](https://img.shields.io/badge/Ollama-000?style=flat&logo=ollama&logoColor=white)](https://ollama.com)
[![MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Что это
<img width="2555" height="1099" alt="image" src="https://github.com/user-attachments/assets/5422859a-2fe5-440e-a121-f23051d05774" />

Полноценная платформа поиска работы, которая работает прямо в браузере. Загрузи резюме, укажи желаемую должность — и получи:

- **оценку соответствия** вакансии по 10 параметрам (A–F)
- **адаптированное PDF-резюме** с инъекцией ключевых слов под конкретную роль
- **подготовку к интервью** — STAR-истории, поведенческие вопросы, переговоры по зарплате
- **автоматический поиск** вакансий на hh.ru, Хабре, GetMatch и Telegram-каналах
- **трекер откликов** — всё в одном месте, без таблиц вручную

Запускается одной командой: `npm run web` → [http://localhost:3000](http://localhost:3000)

---

## Что добавлено в этом форке (относительно оригинала)

### Веб-интерфейс (`web/`)

Браузерный дашборд — запускается командой `node web/server.mjs` или двойным кликом на `start.bat`.

- **Дашборд вакансий** — фильтрация по источнику, статусу, оценке; полнотекстовый поиск
- **Загрузка CV** — PDF, DOCX или текст прямо из браузера
- **Сканирование** с отображением прогресса в реальном времени (SSE)
- **Telegram-каналы** — добавление и удаление через вкладку "Настройки → Telegram"
- **Настройки профиля** — имя, email, целевые роли, зарплатный диапазон

```bash
# Запуск (Windows)
start.bat          # Запуск одним кликом: проверяет Node, ставит зависимости, открывает браузер

# Или вручную:
npm install
node web/server.mjs   # → http://localhost:3000
```

### Локальный ИИ через Ollama (нулевая стоимость)

```bash
# Установи Ollama: https://ollama.com
ollama pull qwen3:14b   # Рекомендуется (или qwen2.5:14b для GPU 16 ГБ)

node ollama-eval.mjs --file ./jds/job.txt     # Оценить вакансию из файла
node ollama-eval.mjs --lang ru "DevSecOps в Яндекс..."  # Текст прямо в аргументе
```

Конфигурация модели:
```bash
cp config/llm.example.yml config/llm.yml
# Настрой: provider, model, ollama_host
```

### Прямые сканеры российских площадок

| Скрипт | Площадка | Метод |
|--------|----------|-------|
| `hh-scan.mjs` | hh.ru | RSS-лента (без ключей, без авторизации) |
| `habr-scan.mjs` | Хабр Карьера | Playwright-скрапинг |
| `getmatch-scan.mjs` | GetMatch | Playwright + `__NEXT_DATA__` |
| `telegram-scan.mjs` | Telegram-каналы | `t.me/s/handle` (публичные крупные каналы) |

```bash
node hh-scan.mjs                        # Поиск по hh.ru
node hh-scan.mjs --area 2 --period 3   # СПб, за 3 дня
node habr-scan.mjs --keywords "DevSecOps|AppSec"
node telegram-scan.mjs                 # Каналы из portals.yml
node telegram-scan.mjs --dry-run --debug  # Тестовый прогон
```

npm-скрипты:
```bash
npm run hh:scan
npm run habr:scan
npm run ollama:eval -- --file jds/job.txt
npm run web
```

### Профиль DevSecOps для российского рынка

```bash
cp config/profile.devsecops.ru.yml config/profile.yml
# Затем замени "Иван Иванов" на свои данные
```

Включает: archetypes (DevSecOps / AppSec / Cloud Security), веса скоринга под security-рынок (`security_tooling_match`, `remote_friendly`, `brand_recognition`), целевые компании (PT, Kaspersky, BI.ZONE, Сбер, Яндекс), настроен на русские режимы (`modes_dir: modes/ru`).

```bash
cp templates/portals.ru.example.yml portals.yml
# Настроены: hh.ru, Хабр Карьера, GetMatch, SuperJob, ключевые ИБ-компании РФ
```

---

## Быстрый старт (Windows)

### Способ 1 — скачать архив (для не-разработчиков)

1. Нажми **[⬇ Скачать ZIP](https://github.com/Abdeygodin/career-ops/archive/refs/heads/main.zip)**
2. Распакуй в любую папку
3. Дважды кликни `start.bat` — браузер откроется автоматически

### Способ 2 — через git (для разработчиков)

```bash
git clone https://github.com/Abdeygodin/career-ops.git
cd career-ops
```

Дальше дважды кликни `start.bat` — он сам установит зависимости и откроет браузер.

<details>
<summary>Ручная установка (если start.bat не подходит)</summary>

```bash
# Установи зависимости
npm install
npx playwright install chromium

# Настрой профиль (выбери под свою специализацию)
cp config/profile.devsecops.ru.yml config/profile.yml
# Открой config/profile.yml и заполни: full_name, email, phone

# Настрой порталы (российский рынок)
cp templates/portals.ru.example.yml portals.yml

# Запусти
npm run web   # → http://localhost:3000
```

</details>

### Выбор ИИ-провайдера

Без ИИ приложение работает (трекер, сканирование, фильтры), но оценка вакансий и подготовка к интервью — недоступны. Выбери вариант под свою ситуацию:

| Вариант | Цена | Требования | Когда выбирать |
|---------|------|------------|----------------|
| **OpenRouter** (бесплатно) | Бесплатно | Только браузер | Нет GPU, хочу попробовать |
| **Ollama** (локально) | Бесплатно | GPU 8+ ГБ VRAM | Есть видеокарта, важна приватность |
| **Ollama на CPU** | Бесплатно | 16+ ГБ RAM, медленно | Есть RAM, нет GPU |
| **Claude API** | Платно | Карта, VPN | Хочу лучшее качество |

#### Вариант А — OpenRouter (проще всего, бесплатно)

1. Зарегистрируйся на [openrouter.ai](https://openrouter.ai)
2. Создай бесплатный API-ключ в разделе Keys
3. В приложении открой **Настройки → ИИ**, выбери провайдер **OpenRouter**, вставь ключ
4. Выбери модель `meta-llama/llama-3.3-70b-instruct:free` (бесплатная, качество хорошее)

#### Вариант Б — Ollama локально (нулевая стоимость, есть GPU)

```bash
# Скачай и установи: https://ollama.com
ollama pull qwen3:14b        # ~8 ГБ, нужна видеокарта 8+ ГБ VRAM
# Если видеокарта слабее или её нет:
ollama pull qwen3:8b         # ~5 ГБ VRAM или 16 ГБ RAM на CPU (медленно)
```

В настройках приложения провайдер уже выставлен на Ollama по умолчанию.

---

## Возможности оригинального career-ops

| Функция | Описание |
|---------|----------|
| **Авто-пайплайн** | Вставь URL → оценка + PDF + запись в трекере |
| **Оценка A–F** | Совпадение с CV, компенсация, культура, STAR-истории |
| **Банк историй** | STAR+R истории накапливаются через все оценки |
| **ATS PDF** | Резюме с инъекцией ключевых слов, дизайн Space Grotesk |
| **Пакетная обработка** | Параллельная оценка 10+ вакансий через sub-agents |
| **Переговоры** | Скрипты зарплатных переговоров |
| **Dashboard TUI** | Go + Bubble Tea терминальный интерфейс |
| **Human-in-the-Loop** | ИИ рекомендует — ты решаешь. Автоотправки нет. |

---

## Команды Claude Code

```
/career-ops                       → Меню всех команд
/career-ops {URL или текст JD}    → Полный авто-пайплайн
/career-ops scan                  → Сканирование порталов
/career-ops pdf                   → Генерация ATS-резюме
/career-ops batch                 → Пакетная оценка
/career-ops tracker               → Статус откликов
/career-ops apply                 → Заполнение формы отклика
/career-ops pipeline              → Обработка очереди URL
/career-ops contacto              → Сообщение в LinkedIn
/career-ops deep                  → Анализ компании
```

---

## Структура проекта

```
career-ops/
├── start.bat                    ← одиночный запуск (Windows)
├── SETUP.md                     ← инструкция по установке
├── web/                         ← веб-интерфейс (Express + SSE)
│   ├── server.mjs
│   ├── public/
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   └── lib/                     ← парсеры данных
├── hh-scan.mjs                  ← hh.ru RSS сканер
├── habr-scan.mjs                ← Хабр Карьера сканер
├── getmatch-scan.mjs            ← GetMatch сканер
├── telegram-scan.mjs            ← Telegram-каналы
├── ollama-eval.mjs              ← локальный ИИ (Qwen3/Llama)
├── Modelfile                    ← конфигурация Ollama-модели
├── config/
│   ├── profile.example.yml      ← шаблон профиля (общий)
│   ├── profile.devsecops.ru.yml ← готовый DevSecOps профиль (РФ)
│   └── llm.example.yml          ← конфигурация LLM-провайдера
├── templates/
│   ├── portals.ru.example.yml   ← порталы российского рынка
│   └── portals.example.yml      ← международные порталы
├── modes/
│   ├── ru/                      ← русские режимы оценки
│   └── ...                      ← 14 режимов навыков
├── cv.md                        ← ваше CV (gitignored)
├── portals.yml                  ← ваши порталы (gitignored)
├── config/profile.yml           ← ваш профиль (gitignored)
├── data/                        ← трекер (gitignored)
├── reports/                     ← отчёты (gitignored)
└── output/                      ← PDF (gitignored)
```

---

## Системные требования

| | Минимум | Рекомендуется |
|---|---|---|
| RAM | 8 ГБ | 16+ ГБ |
| GPU (для Ollama) | — | Nvidia 8+ ГБ VRAM |
| Диск | 15 ГБ | 25 ГБ |
| Node.js | 20+ | 22+ |
| ОС | Windows 10 / macOS / Linux | Windows 11 |

---

## Дисклеймер

**career-ops — локальный open-source инструмент.** CV, контакты и данные остаются на вашей машине. Данные отправляются напрямую выбранному AI-провайдеру (Anthropic, Ollama-local и др.). Всегда проверяйте сгенерированный контент перед отправкой. Соблюдайте ToS площадок.

Подробнее: [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md). Лицензия MIT.

---

## Оригинальный проект

Этот форк основан на [santifer/career-ops](https://github.com/santifer/career-ops) — спасибо автору за открытый исходный код и архитектуру.
