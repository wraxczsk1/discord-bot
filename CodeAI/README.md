# Code AI – programátorské IDE (Electron + Monaco + lokální Qwen)

1. Nainstaluj Node.js (https://nodejs.org)
2. V této složce spusť:
   npm install
   npm start
3. V Code AI otevři Profil a vyber „Qwen lokálně“. Průvodce „Nastavit AI“ nabídne odkaz na [LM Studio](https://lmstudio.ai/download) a [Qwen modely](https://huggingface.co/Qwen).
4. V LM Studio stáhni Qwen model, otevři Developer / Local Server a spusť OpenAI-compatible server na `http://127.0.0.1:1234`. V Code AI klikni na „Ověřit připojení“; dostupný model se automaticky vybere. Místní model nevyžaduje API klíč, ale potřebuje dostatek paměti a výkonu počítače.

V nastavení lze vybrat specializovaného agenta a jednu nebo více dovedností AI. Při startu se zobrazí načítací obrazovka s aktuálním přehledem změn. Pokud je Qwen server vypnutý, chat nabídne přímý odkaz a postup připojení.

Chaty a jejich historie se ukládají lokálně do uživatelských dat aplikace. Chaty ani přiložené soubory se automaticky nemažou. V nastavení je možné změnit profil, model a barevné schéma.

Odeslanou zprávu lze tlačítkem „Upravit“ změnit a znovu odeslat; starší odpovědi za ní se nahradí novým výsledkem. Kód z odpovědi AI lze tlačítkem „Vložit do složky“ uložit do otevřeného projektu; zobrazí se dialog pro výběr názvu a umístění uvnitř projektu.

Lze připojit až 5 souborů, složek, odkazů nebo ZIP archivů najednou. Soubory zůstávají na původním místě; do požadavku se načítá omezený textový výňatek, obrázky/PDF do 5 MB a celkem nejvýše 8 MB multimediálních dat. Z archivu ZIP nebo složky se načítá omezený výběr textových souborů. Webové vyhledávání používá Anthropic API a zobrazuje odkazy na zdroje, pokud je model vrátí. Pro spuštění aktuálního souboru je dostupný základní běh JavaScriptu přes Node.js a Pythonu přes `python`.

Lokální Qwen neúčtuje API tokeny, ale model je nutné stáhnout a jeho běh spotřebovává výkon a paměť počítače; délku kontextu stále omezuje model. Webové hledání vyžaduje online vyhledávací zdroj. Výsledek webového vyhledávání není zárukou pravdivosti; zdroje je třeba ověřit. Soubory a přepínané panely průzkumníku zůstávají dostupné při přepínání Průzkumník/Hledání.

Instalační balíček (.exe / .dmg / .AppImage) vytvoří `npm run dist`. Automatické aktualizace aplikace jsou napojené na veřejné [GitHub Releases](https://github.com/wraxczsk1/discord-bot/releases). V repozitáři zatím není publikované vydání, proto se aktualizace začnou nabízet až po vydání prvního instalátoru. Pro publikaci nastav `GH_TOKEN` s oprávněním k zápisu a spusť `npm run dist -- --publish always`; Electron Builder přiloží instalační soubory a metadata aktualizací. Aktualizaci modelu Qwen spravuje uživatel v LM Studio.
