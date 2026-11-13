# Datenset — Account Health Copilot

**Datei:** `data/accounts.json`
**Stand:** generiert für 2026-08-10, 25 fiktive Accounts, 4 fiktive CSMs.
**Wichtig:** Alle Kunden, Personen und Zahlen sind vollständig erfunden. Die Domänenlogik (Modul-basierte Lizenzierung, Sessions/User als Nutzungssignal, wöchentliches CSAT, periodisches NPS, QBR-Rhythmus) ist inspiriert von echter Berufserfahrung als Head of CSM (EMEA/APAC) mit einer SaaS-CDP-Software als lizenziertem Produkt und Gainsight als CS-Plattform — keine echten Kundendaten, Modul-Namen oder Preise wurden übernommen.

## Warum diese Struktur

Du hast als reale KPIs genannt: Sessions/User-Nutzung pro Modul, Support-Tickets, Anzahl Feature-Requests, wöchentliche Zufriedenheit, NPS, Renewal-Termine (teils mehrjährig mit jährlichem Turnus), volumenbasierte Abrechnung. Das Datenset bildet genau diese Felder ab, ergänzt um zwei Signale, die in echten CS-Praktiken oft unterschätzt werden, aber sehr aussagekräftig sind: **Champion-Status** (verlässt der interne Fürsprecher das Unternehmen, steigt das Risiko stark, unabhängig von Nutzungszahlen) und **freie Texte** (Ticket-/E-Mail-Ausschnitte), die später vom KI-Layer gelesen werden.

## CSM-Team (`csms`)

4 fiktive CSMs mit Regionalzuständigkeit, passend zu deiner Erfahrung mit einem internationalen EMEA/APAC-Team:

| CSM-ID | Name | Abdeckung |
|---|---|---|
| CSM-1 | Lukas Bergmann | DACH & Südeuropa |
| CSM-2 | Fiona Callahan | UK & Irland, Nordics & Benelux |
| CSM-3 | Priya Raghavan | SEA & Indien |
| CSM-4 | Wei Chen | ANZ & Japan/Korea |

## Accounts (`accounts`) — 25 Einträge

Verteilung nach Risikoprofil (intern als `riskArchetype` markiert, damit spätere Scoring-Tests nachvollziehbar sind — das Feld selbst ist ein Hilfsfeld für die Datengenerierung, kein KPI):

- `healthy_growth`: 6 — wachsend, hohe Adoption, aktive Champions
- `stable`: 7 — solide, wenig Auffälligkeiten
- `watch`: 6 — erste Warnsignale, aber nicht akut
- `at_risk`: 4 — mehrere gleichzeitige Risikosignale
- `critical`: 2 — Extremfälle (Champion weg, alles rückläufig)

### Feldübersicht pro Account

```
accountId, accountName, industry, region (EMEA/APAC), subregion, csmId

contract:
  type ("single-year" | "multi-year"), termYears, startDate,
  nextRenewalDate, arrUSD

licensedModules: [{ name, tier (Standard/Advanced/Enterprise), licensedUsers }]

usage:
  licensedUsersTotal, activeUsers, adoptionRatePct,
  sessionsLast3Months [älteste→neueste], sessionsTrendPct

support:
  openTickets, recurringTicketTopic (Thema oder null),
  avgResolutionDays, featureRequestsCount, topFeatureRequest

relationship:
  weeklyCSAT: [{ weekStartDate, score (1-5, 0.5er-Schritte) }] × 8 Wochen
  npsHistory: [{ quarter, score (0-10) }] × 3 Quartale
  championName, championStatus ("active" | "recently_departed" | "unknown")
  execSponsorEngaged (bool)
  lastInteractionDaysAgo, lastQBRDate, nextQBRDate
  onboardingStatus ("steady_state" | "recent_onboarding")

freeTextArtifacts: [{ type ("ticket"|"email"|"chat"), date, text }]
  — für den späteren KI-Layer (Sentiment, Narrativ, Empfehlungen)

location: { city, country, lat, lng }
  — fiktiver Firmensitz pro Account, passend zur bestehenden subregion,
  vorbereitet für eine spätere Kartenansicht (noch nicht in der App genutzt)
```

## Bewusste Annahmen (bitte gegenlesen)

- **Währung:** USD für ARR (global gängiger SaaS-Reporting-Standard). Sag Bescheid, falls EUR passender ist.
- **CSAT-Skala:** 1-5 in 0,5er-Schritten, wöchentlich erfasst (wie in deinem Gainsight-Setup vermutlich üblich).
- **NPS:** 0-10 Einzelwert pro Quartal und Account (nicht der aggregierte Firmen-NPS über alle Kunden, sondern der letzte Account-Score) — das war dein Hinweis "wir haben viel mit NPS gearbeitet", jetzt als dritte Zufriedenheits-Dimension neben CSAT ergänzt.
- **Module:** 6 generische Modulnamen (Journey Orchestration, Digital Intelligence, Identity Resolution, Offer Management, Data Activation Hub, Predictive Analytics) — bewusst nicht die echten CDP-Modulnamen, um near-realistische aber vertraulichkeitsfreie Daten zu haben.
- **Vertragslogik:** `nextRenewalDate` ist immer ein jährlicher Termin (auch bei Mehrjahresverträgen), passend zu deiner Beschreibung "Mehrjahresverträge mit jährlichem Renewal-Termin".

## Nächster Schritt

Dieses Datenset ist die Grundlage für den Scoring-/Dashboard-Prompt. Bevor ich den anpasse: passt die Struktur so, oder fehlt dir ein Feld, das du im echten Alltag ständig gebraucht hast?
