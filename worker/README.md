# AFootball güvenli Worker

Bu klasör, ücretsiz Cloudflare Worker + D1 altyapısıdır. Firebase Google oturumunu Worker tarafında doğrular; coin, süre ödülü ve hediye kodlarını D1'de tutar.

## Cloudflare ayarları

- Worker adı: `afootball`
- Root directory: `worker`
- Deploy command: `npx wrangler deploy`
- Preview command: `npx wrangler preview`
- D1 binding: `AF_DB` → `afootball-data`

`wrangler.jsonc` içindeki D1 kimliği girilmiştir. API'nin adresi `https://afootball.atlasd907.workers.dev` olur.

## Güvenlik notu

Tarayıcı, Worker'a Firebase Google kimlik belirteci gönderir. Worker, Google'ın imzaladığı belirteci doğrulamadan hiçbir coin işlemini yapmaz. Kod kullanımı ve beş dakikalık ödül D1'de hesap başına tutulur; sayfayı yenilemek veya tarayıcı verisini değiştirmek yeni coin oluşturmaz.
