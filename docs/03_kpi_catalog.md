# KPI-Katalog — Account Health Copilot

Konsolidierte KPI-Liste für das Head-of-CS-Dashboard, abgeleitet aus realer CSM-Praxis (SaaS-CDP / Gainsight) und ergänzt um Vorschläge als erfahrener Projektleiter. Dient als verbindliche Grundlage für den Build-Prompt.

## 1. Vertrag & Commercial
- Account-Name, Region/Subregion, zuständiger CSM
- Lizenzierte Module (Name, Tier, lizenzierte User pro Modul)
- Vertragstyp (Einzeljahr / Mehrjahresvertrag mit jährlichem Renewal-Termin)
- ARR
- Nächstes Renewal-Datum + Tage bis Renewal

## 2. Nutzung & Adoption
- Aktive vs. lizenzierte User → Adoption Rate
- Sessions-Trend (3-Monats-Verlauf)
- Modul-Nutzung (welches lizenzierte Modul bleibt ungenutzt → Downsell-Risiko *oder* Enablement-Bedarf)

## 3. Support & Produkt
- Offene Tickets
- Wiederkehrendes, ungelöstes Ticket-Thema (ja/nein + Thema)
- Ø Lösungszeit
- Anzahl Feature-Requests + Top-Request

## 4. Beziehung & Zufriedenheit
- **Wöchentliches CSAT** (1-5, Trend über 8 Wochen) — operative Pulsmessung
- **Quartalsweises NPS** (0-10, Trend über 3 Quartale) — strategische Beziehungsmessung
- **Champion-Status** (aktiv / kürzlich abgesprungen / unbekannt) — einer der stärksten Einzelindikatoren in der Praxis, unabhängig von Nutzungszahlen
- Exec-Sponsor-Engagement (ja/nein)

## 5. Governance & Kadenz
- Letztes / nächstes QBR-Datum
- Tage seit letzter Interaktion
- Onboarding-Status (kürzlich onboarded vs. steady state)

## 6. Aggregierte Scores (berechnet, nicht erfasst)
- **Health Score** (0-100, gewichtete Kombination aller Risikosignale)
- **Churn-Risk-Kategorie** (niedrig/mittel/hoch, aus Health Score abgeleitet)
- **Expansion-Potenzial-Score** — eigener Vorschlag, ergänzt Churn-Fokus um Wachstumsperspektive: hohe Adoption + positive Feature-Requests + gute CSAT/NPS + ungenutzte Modul-Whitespace = Expansion-Kandidat

## Gewichtung des Health/Churn-Scores (Vorschlag, Erweiterung des ursprünglichen 6-Kriterien-Modells um NPS & Champion-Risiko)

| Kriterium | Gewicht |
|---|---|
| Nutzungs-/Adoptionsrückgang | 20% |
| Wiederkehrendes, ungelöstes Ticket-Thema | 15% |
| CSAT-Trend (Wochenwerte) | 15% |
| NPS (Höhe + Trend) | 15% |
| Champion-Risiko | 15% |
| Keine Interaktion 30+ Tage | 10% |
| Exec-Sponsor nicht engagiert | 5% |
| QBR überfällig | 5% |

## KI-Einsatzideen (Priorisierung für den Copilot-Layer)

1. Zusammengesetzte Risikomuster erkennen (Signale, die einzeln unauffällig sind, in Kombination aber kritisch)
2. QBR-Vorbereitung automatisch aus Tickets/Feature-Requests/Sentiment-Verlauf generieren
3. Team-Priorisierung für den Head of CS (nicht nur Einzelkonto-Sicht, sondern "worauf soll sich mein Team diese Woche konzentrieren")
4. Feature-Request-Aggregation über Accounts hinweg (Signal fürs Produktteam)
5. Entwürfe für Renewal-/Risiko-E-Mails
