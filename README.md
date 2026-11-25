# 나미 투약 수첩

반려동물 나미의 약 일정을 가족이 함께 챙기는 웹앱. https://nami-meds-app.web.app

- `public/` — 웹앱(Firebase Hosting). 화면을 고친 뒤 `public/sw.js`의 `CACHE` 버전을 하나 올리고 `firebase deploy --only hosting`.
- `firestore.rules` — 가족 ID를 아는 사람만 그 가족 기록을 읽고 씀.
- `notify/send.mjs` — 5분마다 GitHub Actions(`.github/workflows/reminders.yml`)가 실행. 먹일 시간이 됐는데 체크가 없으면 푸시, 15분 뒤와 1시간 뒤에도 없으면 한 번씩 더. 지금은 Cloudflare Workers(`worker/`)가 5분마다 실행한다.
- 비밀값(GitHub Secrets): `FIREBASE_API_KEY`, `FAMILY_ID`, `VAPID_PUBLIC`, `VAPID_PRIVATE`. 가족 ID는 저장소에 넣지 않는다.
