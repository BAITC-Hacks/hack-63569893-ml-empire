# hack-63569893-ml-empire
Hackathon team repository for ML_Empire

## Voice Router

- [Архитектура решения](docs/voice-router-architecture.md)
- [План разработки бэкенда](docs/superpowers/plans/2026-09-23-voice-router-backend.md)
- [Контракт подключения фронтенда](frontend/docs/frontend.md)
- [Функции и запуск фронтенда](frontend/README.md)
- [Визуальный стиль Halyk для интерфейса](frontend/docs/halyk-visual-style-analysis.md)
- [Описание датасета и условий кейса](datas/README.ru.md)
- [Покрытие требований банка, frontend-плана и критериев оценки](frontend/docs/requirements-coverage.md)
- [Проверки и оставшаяся голосовая приёмка](frontend/docs/frontend-verification.md)

## Локальная проверка фронтенда

```bash
npm --prefix frontend ci
npm --prefix frontend run dev:fixture
```

UI: `http://127.0.0.1:5175`. Это **синтетический тестовый сервер**, не LLM/STT/TTS-робот. Не вводите реальные персональные данные. `Ctrl+C` останавливает оба локальных сервиса. Для подключения настоящего API: `npm --prefix frontend run dev`; подробности в [frontend README](frontend/README.md).

Готовность клиента не означает прохождение полного ТЗ: реальная маршрутизация, голосовые провайдеры, измерения на устройстве и общий запуск всего решения ещё требуют интеграции.
