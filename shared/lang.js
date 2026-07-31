/**
 * Pure language heuristics (H + N testable).
 */
(function (g) {
  const DeEn = g.DeEn || (g.DeEn = {});

  const DE_WORDS =
    /\b(der|die|das|und|ist|nicht|mit|für|auf|ein|eine|einen|einem|einer|ich|wir|sie|den|dem|des|von|zu|im|am|als|auch|oder|aber|wird|sind|hat|haben|kann|nach|bei|aus|über|wenn|nur|noch|schon|mehr|sehr|alle|diese|dieser|werden|bitte|danke|uhr|heute|morgen|hier|dort|jetzt|dann|weil|dass|daß|kein|keine|durch|gegen|ohne|unter|zwischen|während|seit|sowie|jedoch|bereits|wieder|immer|etwas|nichts|jemand|warum|wieso|welche|welcher|welches|ihre|ihren|seinem|seiner|unsere|können|müssen|sollen|wollen|machen|gehen|kommen|sehen|geben|nehmen|finden|stehen|liegen|bleiben|scheinen|heißt|grüß|tschüss|willkommen|anmeldung|abmelden|speichern|löschen|suchen|einstellungen|datenschutz|impressum|agb|weiter|zurück|schließen|öffnen|hilfe|konto|passwort)\b/gi;

  const EN_WORDS =
    /\b(the|and|is|are|was|were|for|with|this|that|from|your|have|has|will|not|you|our|can|all|about|more|been|their|which|would|there|what|when|who|how|also|into|than|then|only|other|some|such|these|those|please|click|login|logout|search|home|settings|privacy|cookie|accept|continue|cancel|submit|download|upload|account|password|welcome|hello|thanks|help|close|open|next|back|save|delete|edit|view|share|follow)\b/gi;

  function countMatches(re, text) {
    re.lastIndex = 0;
    const m = text.match(re);
    return m ? m.length : 0;
  }

  /**
   * @param {string} text
   * @returns {{ isGerman: boolean, confidence: number, deHits: number, enHits: number, umlauts: number }}
   */
  function scoreGermanText(text) {
    if (!text || text.length < 8) {
      return { isGerman: false, confidence: 0, deHits: 0, enHits: 0, umlauts: 0 };
    }
    const deHits = countMatches(DE_WORDS, text);
    const enHits = countMatches(EN_WORDS, text);
    const umlauts = (text.match(/[äöüÄÖÜß]/g) || []).length;
    const longCompounds = (text.match(/\b[A-ZÄÖÜ][a-zäöüß]{10,}\b/g) || []).length;

    let score = 0;
    score += Math.min(deHits, 20) * 0.04;
    score += Math.min(umlauts, 12) * 0.05;
    score += Math.min(longCompounds, 6) * 0.03;
    score -= Math.min(enHits, 20) * 0.035;
    score = Math.max(0, Math.min(1, score));

    if (umlauts >= 3 && deHits >= 2) score = Math.max(score, 0.72);
    if (deHits >= 6 && deHits > enHits) score = Math.max(score, 0.65);
    if (enHits >= 8 && enHits > deHits * 2 && umlauts === 0) score = Math.min(score, 0.25);

    const isGerman = score >= 0.42 && deHits + umlauts >= 2;
    return { isGerman: isGerman, confidence: score, deHits: deHits, enHits: enHits, umlauts: umlauts };
  }

  /**
   * Soft-redact emails/phones before network send (O/privacy hardening).
   * Keeps length roughly so translation still works.
   */
  function softRedactPII(text) {
    if (!text) return text;
    return String(text)
      .replace(/[\w.+-]+@[\w.-]+\.\w{2,}/g, "[email]")
      .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[phone]");
  }

  DeEn.lang = {
    scoreGermanText: scoreGermanText,
    softRedactPII: softRedactPII,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = DeEn.lang;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
