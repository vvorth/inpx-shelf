# docs

| Path | Contains | Rules |
|---|---|---|
| `docs/*.md` | User docs (Russian) linked from `README.ru.md` and `README.md` ( `docker.md`, `config.md`, `kobo.md`, ...) and project docs (`kobo-protocol.md`): how something works or is set up now | Current state only, short. Update with the code. No history, no lore. A new user doc gets a link in both READMEs |
| `docs/research/` | Researched information: findings, comparisons, reviews, design proposals | Facts and conclusions, dated in the text. Never linked from project docs |
| `docs/images/` | Screenshots for `README.md` and `README.ru.md`, light and dark (`<picture>`), WebP | A demo library of public domain books, never a real one |
| `docs/plans/` | Plans for complex multi-step changes, when needed | Delete the plan when it is implemented. Never linked from project docs |

- Project docs are for the project only: they may link to each other, the READMEs and code, never to `research/` or `plans/`.
- Write in the language of the file being edited (user docs are Russian).
