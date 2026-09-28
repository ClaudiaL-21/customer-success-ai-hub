# Sprint 15: Supabase-Datenbasis

Projekt: `cbzxrbrfwifxvbvljelh` (Frankfurt). Die vor Sprint 15 verifizierte
GitHub-Sicherung ist Tag `pre-sprint-15-2026-09-26`.

Die Datenbank enthält die sechs synthetischen CSMs und 35 Accounts des
ursprünglichen Demos. `csms` und `accounts` besitzen stabile Schlüssel und
Beziehungen; das vollständige bisherige Account-Dokument bleibt in `data`
erhalten, damit die acht Health-Faktoren und QBRs unverändert berechnet werden.
`dataset_metadata` hält den ursprünglichen Snapshot-Zeitpunkt. Die Migration
liegt unter `supabase/migrations/`; `scripts/seed-supabase.js` erzeugt neun
wiederholbar ausführbare, rein ergänzende Importpakete.

Alle drei Tabellen verwenden RLS. Weder `anon` noch `authenticated` erhalten
Tabellenrechte. Die Hub-API ruft serverseitig die schreibgeschützte Funktion
`hub_account_dataset()` mit einem Secret Key ab. Der Key gehört ausschließlich
in die ignorierte `.env` oder später in geschützte Deployment-Variablen:

```
ACCOUNT_DATA_SOURCE=supabase
SUPABASE_URL=https://cbzxrbrfwifxvbvljelh.supabase.co
SUPABASE_SECRET_KEY=<server-side-secret-key>
```

`/api/accounts` lädt pro Anfrage einen frischen, konsistenten Datensatz und
gibt nur die bisherigen fiktiven Demo-Daten aus. Die vorhandenen Analyse-,
Freigabe- und QBR-Endpunkte verwenden denselben Loader. Bei einem
Datenbankfehler wird ein Fehler angezeigt; es erfolgt kein unbemerktes
Zurückfallen auf die alte JSON-Datei. `ACCOUNT_DATA_SOURCE=json` bleibt als
explizite Offline-Testkonfiguration verfügbar.

Diese Migration speichert noch keine eingehenden E-Mails, Signale oder
Freigaben. Die dafür erforderlichen Tabellen, Zugriffskontrollen und die
n8n-Anbindung folgen in den nächsten Arbeitspaketen von Sprint 15. Bis dahin
enthält diese Datenbank ausschließlich den synthetischen Portfolio-Snapshot.
