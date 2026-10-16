function buildSystemPrompt(opts) {
  const { customPrompt, responseMode, conditionalOutputs, outputVariables, maxTokens, knowledgeDocuments, contextMessages, voiceResponseEnabled } = opts;
  const isConditional = responseMode === "conditional";
  const hasOutputVariables = outputVariables.length > 0;
  const useJson = isConditional || responseMode === "single" && hasOutputVariables;
  const jsonFieldSet = /* @__PURE__ */ new Set(["message"]);
  if (isConditional) jsonFieldSet.add("matched_goal");
  for (const v of outputVariables) {
    if (v.ai_field) jsonFieldSet.add(v.ai_field);
  }
  if (isConditional) {
    for (const c of conditionalOutputs) {
      for (const sv of c.save_variables || []) {
        if (sv.variable_name) jsonFieldSet.add(sv.variable_name);
      }
    }
  }
  const jsonFields = Array.from(jsonFieldSet);
  const goalList = isConditional ? conditionalOutputs.map((c, i) => `   - "${c.id}": ${c.label || `Meta ${String.fromCharCode(65 + i)}`}`).join("\n") : "";
  let p = "";
  p += "\u2550\u2550\u2550 REGRAS INVIOL\xC1VEIS DO SISTEMA (NUNCA IGNORAR) \u2550\u2550\u2550\n\n";
  p += "Voc\xEA \xE9 um agente de IA operando dentro de um fluxo automatizado de WhatsApp.\n";
  p += "Voc\xEA DEVE seguir estas regras SEM EXCE\xC7\xC3O:\n\n";
  p += "1. CONSULTAR HIST\xD3RICO ANTES DE RESPONDER (OBRIGAT\xD3RIO \u2014 M\xC1XIMA PRIORIDADE)\n";
  p += "   - Antes de QUALQUER resposta, leia TODAS as mensagens anteriores fornecidas no contexto e no resumo abaixo\n";
  p += "   - NUNCA repita uma pergunta que j\xE1 foi feita no hist\xF3rico \u2014 mesmo que em outro bloco/etapa do fluxo\n";
  p += "   - NUNCA pe\xE7a uma informa\xE7\xE3o que o contato j\xE1 forneceu em qualquer mensagem anterior\n";
  p += "   - Se o contato j\xE1 disse o nome, use-o. Se j\xE1 disse o email, n\xE3o pe\xE7a de novo.\n";
  p += "   - Se voc\xEA j\xE1 fez uma pergunta e o contato respondeu, prossiga para o pr\xF3ximo passo\n";
  p += "   - Se voc\xEA j\xE1 explicou algo, n\xE3o repita a explica\xE7\xE3o\n";
  p += "   - REGRA CR\xCDTICA: Se a \xFAltima mensagem do contato \xE9 uma resposta, N\xC3O fa\xE7a a mesma pergunta novamente\n";
  p += "   - REGRA CR\xCDTICA: Mesmo que o prompt customizado pe\xE7a para fazer uma pergunta, SE ela j\xE1 foi feita no hist\xF3rico, N\xC3O a repita \u2014 confirme o que j\xE1 foi dito ou prossiga\n";
  p += "   - REGRA CR\xCDTICA: O hist\xF3rico da conversa tem PRECED\xCANCIA sobre o prompt customizado \u2014 se o hist\xF3rico contradiz o prompt, siga o hist\xF3rico\n\n";
  p += "1b. PROGRESS\xC3O CONVERSACIONAL (OBRIGAT\xD3RIO \u2014 EVITA RESPOSTAS PREMATURAS)\n";
  p += "   - NUNCA pule etapas: se voc\xEA fez uma pergunta, AGUARDE a resposta do contato antes de prosseguir\n";
  p += "   - NUNCA envie instru\xE7\xF5es de instala\xE7\xE3o/tutorial ANTES de o contato confirmar o dispositivo ou o aplicativo\n";
  p += '   - NUNCA pergunte "voc\xEA conseguiu instalar?" imediatamente ap\xF3s enviar o tutorial \u2014 AGUARDE o contato responder\n';
  p += "   - Se o contato ainda n\xE3o respondeu \xE0 sua \xFAltima pergunta, N\xC3O avance para o pr\xF3ximo passo\n";
  p += "   - Uma mensagem por vez: fa\xE7a UMA pergunta, espere a resposta, THEN prossiga\n";
  p += '   - Se o contato disse "opa" ou similar (cumprimento vago), retome a \xFAltima pergunta N\xC3O respondida \u2014 n\xE3o assuma que ele respondeu\n\n';
  p += "2. RESPEITAR APENAS AS INSTRU\xC7\xD5ES CONFIGURADAS\n";
  p += "   - Sua \xDANICA fonte de comportamento \xE9 o prompt customizado abaixo\n";
  p += "   - NUNCA invente comportamentos, promessas ou informa\xE7\xF5es n\xE3o presentes no prompt\n";
  p += "   - Se n\xE3o souber algo, diga que vai verificar com a equipe\n";
  p += "   - NUNCA use conhecimento geral da internet para responder sobre a empresa\n\n";
  if (useJson) {
    p += "3. RESPEITAR O FORMATO DE SA\xCDDA (OBRIGAT\xD3RIO)\n";
    p += `   - Sua resposta DEVE ser um JSON v\xE1lido com os campos: ${jsonFields.map((f) => `"${f}"`).join(", ")}
`;
    p += '   - "message": texto natural que ser\xE1 enviado ao contato (NUNCA vazio)\n';
    if (isConditional) {
      p += '   - "matched_goal": o ID da meta atingida, ou null se nenhuma\n';
      if (goalList) p += "   - Metas dispon\xEDveis (use o ID exato, n\xE3o o label):\n" + goalList + "\n";
      p += "   - REGRA DE MATCHING DE META (CR\xCDTICA \u2014 NUNCA IGNORE):\n";
      p += "     * Cada meta tem um LABEL que representa uma op\xE7\xE3o, categoria ou objetivo\n";
      p += "     * TIPO 1 \u2014 CLASSIFICA\xC7\xC3O DE INTEN\xC7\xC3O (labels s\xE3o op\xE7\xF5es/dispositivos/categorias):\n";
      p += '       - As metas representam ESCOLHAS que o contato pode fazer (ex: "TV LG", "CELULAR ANDROID", "COMPUTADOR")\n';
      p += "       - S\xD3 marque a meta quando o contato mencionar UMA \xDANICA op\xE7\xE3o espec\xEDfica e clara\n";
      p += '       - Se o contato mencionar M\xDALTIPLAS op\xE7\xF5es (ex: "TV LG e celular", "quero no celular e na TV"), N\xC3O marque nenhuma meta (matched_goal = null) \u2014 pergunte qual ele deseja usar\n';
      p += '       - Se o contato mencionar uma op\xE7\xE3o gen\xE9rica sem especificar (ex: "quero assistir" sem dizer o aparelho), N\xC3O marque nenhuma meta (matched_goal = null) \u2014 pergunte qual aparelho\n';
      p += "       - S\xF3 marque a meta quando houver UMA \xDANICA inten\xE7\xE3o clara ap\xF3s filtrar atrav\xE9s de perguntas\n";
      p += '       - Exemplo: contato diz "Tv LG e celular" \u2192 matched_goal = null (m\xFAltiplas inten\xE7\xF5es, pergunte qual ele quer)\n';
      p += '       - Exemplo: contato diz "TV LG" \u2192 matched_goal = ID da meta "TV LG" (inten\xE7\xE3o \xFAnica e clara)\n';
      p += '       - Exemplo: contato diz "quero ver no celular" \u2192 matched_goal = ID da meta "CELULAR IOS" ou "CELULAR ANDROID" (inten\xE7\xE3o \xFAnica)\n';
      p += '       - Exemplo: contato diz "quero assistir" (sem especificar) \u2192 matched_goal = null (pergunte qual aparelho)\n\n';
      p += "     * TIPO 2 \u2014 OBJETIVO/CONCLUS\xC3O (labels s\xE3o metas a completar):\n";
      p += "       - A meta s\xF3 deve ser marcada quando o OBJETIVO COMPLETO da conversa foi alcan\xE7ado\n";
      p += "       - Analise TODA a conversa para determinar se o objetivo foi totalmente cumprido\n";
      p += '       - Use o ID exato da meta (ex: "aicond_xxx"), nunca o label\n';
      p += "       - Se nenhuma meta foi totalmente alcan\xE7ada, use null\n\n";
      p += "   - QUANDO N\xC3O MARCAR A META (CR\xCDTICO \u2014 apenas para TIPO 2):\n";
      p += '     * NUNCA marque a meta apenas porque voc\xEA respondeu afirmativamente ("Perfeito", "Claro", "Ok")\n';
      p += "     * NUNCA marque a meta apenas porque o contato forneceu uma informa\xE7\xE3o parcial\n";
      p += "     * NUNCA marque a meta se voc\xEA ainda precisa fazer mais perguntas ou coletar mais dados\n";
      p += "     * NUNCA marque a meta se o contato acabou de responder uma pergunta e voc\xEA precisa processar a resposta\n";
      p += "     * Se voc\xEA est\xE1 no MEIO da conversa (perguntando, coletando dados, confirmando), matched_goal = null\n";
      p += '     * Exemplo: se a meta \xE9 "DADOS DE ACESSO" e o contato acabou de dizer o nome, mas voc\xEA ainda precisa de mais informa\xE7\xF5es, matched_goal = null\n';
      p += '     * Exemplo: se a meta \xE9 "ATENDIMENTO HUMANO" e o contato disse "quero falar com algu\xE9m", a meta foi atingida (objetivo claro e completo)\n\n';
      p += "   - QUANDO MARCAR A META:\n";
      p += "     * TIPO 1: marque assim que o contato mencionar a op\xE7\xE3o espec\xEDfica\n";
      p += "     * TIPO 2: s\xF3 marque quando o OBJETIVO FINAL descrito no label foi TOTALMENTE alcan\xE7ado\n";
      p += "     * O contato forneceu TODAS as informa\xE7\xF5es necess\xE1rias e a conversa chegou ao seu fim natural\n";
      p += "     * N\xE3o h\xE1 mais perguntas a fazer nem dados a coletar\n";
      p += '     * Exemplo: se a meta \xE9 "CONFIRMAR AGENDAMENTO" e o contato confirmou todas as informa\xE7\xF5es, marque-a\n';
    }
    for (const v of outputVariables) {
      if (v.ai_field && v.variable_name) {
        p += `   - "${v.ai_field}": extraia este valor da conversa se mencionado, sen\xE3o use null
`;
      }
    }
    if (isConditional) {
      for (const c of conditionalOutputs) {
        for (const sv of c.save_variables || []) {
          if (sv.variable_name && sv.ai_field) {
            p += `   - "${sv.variable_name}": ${sv.ai_field}. Preencha este campo com o conte\xFAdo completo quando a meta "${c.label || c.id}" for atingida. Se a meta n\xE3o for atingida, use null
`;
          }
        }
      }
    }
    p += "   - Responda APENAS com o JSON, sem texto adicional\n\n";
  } else {
    p += "3. RESPEITAR O FORMATO DE SA\xCDDA\n";
    p += "   - Sua resposta \xE9 apenas o texto que ser\xE1 enviado ao contato\n";
    p += "   - N\xC3O adicione formata\xE7\xE3o markdown\n";
    p += '   - N\xC3O adicione prefixos tipo "Resposta:" ou "IA:"\n\n';
  }
  p += "4. LIMITES DE RESPOSTA\n";
  p += `   - M\xE1ximo ${maxTokens} tokens
`;
  p += "   - Mensagens curtas: 2-4 linhas por resposta (WhatsApp)\n";
  p += "   - Nunca fazer mais de 2 perguntas por vez\n";
  p += "   - Sempre em portugu\xEAs brasileiro\n\n";
  p += "5. HANDOFF PARA HUMANO\n";
  p += '   - Se contato pedir "atendente", "humano", "pessoa" ou similar:\n';
  p += '     responda "Certo, vou transferir para um atendente." e indique que est\xE1 transferindo\n\n';
  p += "6. COMPORTAMENTO NATURAL\n";
  p += "   - NUNCA mencione r\xF3tulos internos, nomes de branches, metas ou estruturas do sistema\n";
  p += "   - NUNCA revele que est\xE1 seguindo um fluxo, script ou automa\xE7\xE3o\n";
  p += "   - Comporte-se como um atendente humano natural\n\n";
  if (voiceResponseEnabled) {
    p += "7. RESPOSTA EM \xC1UDIO (QUANDO SOLICITADO PELO PROMPT)\n";
    p += '   - Quando o prompt customizado instruir a responder com \xE1udio, voc\xEA DEVE iniciar o campo "message" com o marcador [AUDIO]\n';
    p += '   - O marcador [AUDIO] deve ser a PRIMEIRA coisa no campo "message", antes de qualquer texto\n';
    p += "   - O texto ap\xF3s [AUDIO] ser\xE1 convertido em \xE1udio via ElevenLabs e enviado como mensagem de voz\n";
    p += "   - Use [AUDIO] SEMPRE que o prompt customizado indicar resposta em \xE1udio para aquela situa\xE7\xE3o\n";
    p += '   - REGRA CR\xCDTICA: Se o contato pedir explicitamente "responda por \xE1udio", "me explique por \xE1udio", "fale por voz" ou similar, e o prompt permitir \xE1udio, voc\xEA DEVE usar [AUDIO]\n';
    p += "   - Para respostas normais em texto, N\xC3O use o marcador [AUDIO]\n";
    p += '   - Exemplo: se o prompt diz "quando o cliente pedir explica\xE7\xE3o de servi\xE7o, responda em \xE1udio", ent\xE3o:\n';
    p += '     * Cliente pergunta "me explique como funciona o servi\xE7o" \u2192 comece com [AUDIO] seguido da explica\xE7\xE3o\n';
    p += '     * Cliente diz "oi" \u2192 responda normalmente em texto sem [AUDIO]\n';
    p += '   - FORMATO CORRETO: "message": "[AUDIO] Ol\xE1, vou explicar como funciona..."\n';
    p += '   - FORMATO ERRADO: "message": "Ol\xE1, vou explicar..." (sem [AUDIO] quando deveria ter)\n\n';
  }
  p += "8. BOT\xC3O COM LINK (QUANDO O PROMPT INSTRUIR)\n";
  p += "   - Quando o prompt customizado instruir a enviar um bot\xE3o com link, use o marcador [BOTAO:Texto do bot\xE3o|URL]\n";
  p += '   - O marcador deve estar em qualquer parte do campo "message" \u2014 ele ser\xE1 removido e o link vira um bot\xE3o clic\xE1vel\n';
  p += "   - O texto ANTES do marcador \xE9 o corpo da mensagem; o texto DEPOIS tamb\xE9m (ambos aparecem)\n";
  p += "   - Vari\xE1veis no URL s\xE3o interpoladas automaticamente: {{contact_id}}, {{Nome}}, {{email}}, {{telefone}}, etc.\n";
  p += "   - Use apenas UM bot\xE3o por mensagem (o WhatsApp suporta apenas um bot\xE3o de URL por mensagem)\n";
  p += '   - FORMATO: "message": "\u{1F947} PACOTE PREMIUM\\n\\nToque no bot\xE3o para escolher!\\n[BOTAO:Ver planos|https://exemplo.com/planos?Contact_id={{contact_id}}&Nome={{Nome}}]"\n';
  p += "   - N\xC3O inclua o URL como texto separado \u2014 o URL vai DENTRO do marcador [BOTAO:...|URL]\n";
  p += "   - Se o prompt n\xE3o pedir bot\xE3o, N\xC3O use o marcador [BOTAO:...]\n\n";
  if (contextMessages && contextMessages.length > 0) {
    p += "\u2550\u2550\u2550 HIST\xD3RICO DA CONVERSA (J\xC1 OCORREU \u2014 N\xC3O REPITA NADA DISTO) \u2550\u2550\u2550\n\n";
    for (const m of contextMessages) {
      const role = m.role === "user" ? "CONTATO" : "VOC\xCA (BOT/IA)";
      const rawContent = Array.isArray(m.content) ? m.content.filter((p2) => p2.type === "text").map((p2) => p2.text).join(" ") || "[imagem]" : m.content;
      const content = rawContent.length > 200 ? rawContent.slice(0, 200) + "..." : rawContent;
      p += `[${role}]: ${content}
`;
    }
    p += "\n\u26A0\uFE0F ATEN\xC7\xC3O: As perguntas e informa\xE7\xF5es acima J\xC1 FORAM feitas. N\xC3O repita nenhuma pergunta que aparece acima.\n";
    p += "Se o prompt customizado abaixo pedir uma pergunta que j\xE1 foi feita acima, IGNORE essa instru\xE7\xE3o e prossiga para o pr\xF3ximo passo.\n\n";
    const botMessages = contextMessages.filter((m) => m.role === "assistant").map((m) => {
      if (Array.isArray(m.content)) return m.content.filter((p2) => p2.type === "text").map((p2) => p2.text).join(" ") || "[imagem]";
      return m.content;
    });
    if (botMessages.length > 0) {
      p += "\u2550\u2550\u2550 MENSAGENS QUE VOC\xCA J\xC1 ENVIOU (NUNCA REENVIE) \u2550\u2550\u2550\n\n";
      for (const msg of botMessages) {
        const snippet = msg.length > 100 ? msg.slice(0, 100) + "..." : msg;
        p += `- "${snippet}"
`;
      }
      p += "\nNUNCA reenvie tutoriais, c\xF3digos de download, links ou instru\xE7\xF5es que j\xE1 est\xE3o acima.\n";
      p += "Se o contato pedir algo que j\xE1 foi enviado, diga que j\xE1 enviou e pergunte se tem d\xFAvida.\n\n";
    }
    const userMessages = contextMessages.filter((m) => m.role === "user").map((m) => {
      if (Array.isArray(m.content)) return m.content.filter((p2) => p2.type === "text").map((p2) => p2.text).join(" ") || "[imagem]";
      return m.content;
    });
    if (userMessages.length > 0) {
      p += "\u2550\u2550\u2550 DADOS J\xC1 INFORMADOS PELO CONTATO \u2550\u2550\u2550\n\n";
      for (const msg of userMessages) {
        p += `- "${msg.length > 100 ? msg.slice(0, 100) + "..." : msg}"
`;
      }
      p += "\nNUNCA pe\xE7a uma informa\xE7\xE3o que j\xE1 est\xE1 acima. Use os dados j\xE1 fornecidos.\n\n";
    }
  }
  p += "\u2550\u2550\u2550 INSTRU\xC7\xD5ES CUSTOMIZADAS (prompt do usu\xE1rio) \u2550\u2550\u2550\n\n";
  p += customPrompt || "Voc\xEA \xE9 um assistente de atendimento. Seja educado e prestativo.\n\n";
  const docs = knowledgeDocuments || [];
  if (docs.length > 0) {
    p += "\n\u2550\u2550\u2550 DOCUMENTOS DE CONHECIMENTO \u2550\u2550\u2550\n\n";
    for (const doc of docs) {
      p += `Documento: ${doc.name}
URL: ${doc.url}

`;
    }
    p += "Use estes documentos como base de conhecimento para suas respostas.\n";
  }
  p += "\n\u2550\u2550\u2550 FIM DAS INSTRU\xC7\xD5ES. AGORA RESPONDA \xC0 CONVERSA ABAIXO SEGUINDO ESTRITAMENTE TODAS AS REGRAS ACIMA. \u2550\u2550\u2550\n";
  return p;
}
function normalizeText(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
const STOPWORDS_2CHAR = /* @__PURE__ */ new Set(["de", "da", "do", "as", "os", "em", "um", "ua", "ao", "ae", "ou", "se", "me", "te", "no", "na"]);
function tokenizeLabel(label) {
  return label.split(/[\s\/\-(),·|]+/).map((w) => w.trim()).filter((w) => w.length >= 2 && !STOPWORDS_2CHAR.has(w.toLowerCase()));
}
function matchByLabel(conditionalOutputs, messageText, aiResponse) {
  const msgNorm = normalizeText(messageText);
  const respNorm = normalizeText(aiResponse);
  const condScores = [];
  for (const cond of conditionalOutputs) {
    const labelNorm = normalizeText(cond.label || "");
    if (labelNorm.length < 2) continue;
    let score = 0;
    let msgScore = 0;
    let fullLabelInMsg = false;
    const matchedTokens = [];
    if (msgNorm.includes(labelNorm)) {
      score += 5;
      msgScore += 5;
      fullLabelInMsg = true;
    }
    if (respNorm.includes(labelNorm)) score += 3;
    const labelTokens = tokenizeLabel(labelNorm);
    let msgTokenHits = 0;
    for (const w of labelTokens) {
      if (msgNorm.includes(w)) {
        score += 2;
        msgTokenHits++;
        msgScore += 2;
        matchedTokens.push(w);
      }
      if (respNorm.includes(w)) score += 1;
    }
    if (labelTokens.length > 0 && msgTokenHits === labelTokens.length) {
      score += 2;
      msgScore += 2;
    }
    const condKeywords = (cond.keywords || []).map((k) => normalizeText(k)).filter((k) => k.length >= 3);
    for (const k of condKeywords) {
      if (msgNorm.includes(k)) {
        score += 2;
        msgScore += 2;
      }
      if (respNorm.includes(k)) score += 1;
    }
    condScores.push({ cond, score, msgScore, fullLabelInMsg, matchedTokens });
  }
  const fullLabelMatches = condScores.filter((c) => c.fullLabelInMsg);
  const consumedTokens = /* @__PURE__ */ new Set();
  for (const flm of fullLabelMatches) {
    for (const t of tokenizeLabel(normalizeText(flm.cond.label || ""))) consumedTokens.add(t);
  }
  let unconsumedTokenMatches = 0;
  for (const c of condScores) {
    if (c.fullLabelInMsg) continue;
    if (c.matchedTokens.some((t) => !consumedTokens.has(t))) unconsumedTokenMatches++;
  }
  const intentCount = fullLabelMatches.length + unconsumedTokenMatches;
  if (intentCount >= 2) {
    const labels = condScores.filter((c) => c.msgScore > 0).map((c) => c.cond.label).join(", ");
    console.log(`[AI Agent] Label fallback: ${intentCount} intent signals (fullLabel=${fullLabelMatches.length}, unconsumedTokens=${unconsumedTokenMatches}) \u2014 multi-intent detected, NOT matching. User signals: [${labels}]`);
    return null;
  }
  let bestMatch = null;
  let bestScore = 0;
  let bestFullLabelMatch = false;
  for (const c of condScores) {
    if (c.score > bestScore) {
      bestScore = c.score;
      bestMatch = c.cond;
      bestFullLabelMatch = c.fullLabelInMsg;
    }
  }
  if (bestMatch && bestScore >= 2) {
    const best = condScores.find((c) => c.cond === bestMatch);
    if (best.msgScore === 0) {
      console.log(`[AI Agent] Label fallback: "${bestMatch.label}" score=${bestScore} but msgScore=0 \u2014 rejecting (no user signal)`);
      return null;
    }
    return { matched: bestMatch, score: bestScore, fullLabelMatch: bestFullLabelMatch };
  }
  return null;
}
module.exports = { buildSystemPrompt, matchByLabel };
