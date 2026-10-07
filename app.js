// O GitHub Pages não deixa mandar o cabeçalho frame-ancestors: sem isto, outro site poderia
// embutir a página e induzir alguém a transmitir ou digitar o código dentro dele.
if (window.top !== window.self) {
  document.body.replaceChildren(Object.assign(document.createElement('a'), { href: location.href, target: '_blank', rel: 'noopener', textContent: 'Abrir o SharedScreen' }));
  throw new Error('SharedScreen embutido em outro site');
}

const PRESETS = {
  motion: { w: 1920, h: 1080, fps: 60, mbps: 10, hint: 'motion' },
  detail: { w: 1920, h: 1080, fps: 15, mbps: 6, hint: 'detail' },
  leve: { w: 1280, h: 720, fps: 30, mbps: 2.5, hint: 'motion' },
};
// Opus sai mono ~32 kbps por padrão; pede estéreo e mais bitrate (música/jogo).
const stereo = sdp => sdp.replace(/useinbandfec=1/g, 'useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000');
// Identidade da transmissão: cada ponta usa UM certificado DTLS em todas as suas conexões, e o
// transmissor põe a impressão digital do dele no link (&k=). Quem assiste confere cada conexão
// contra ela ANTES de mandar o código: impostor com o mesmo id de sala, ou alguém no meio da
// conexão, não tem esse certificado — o navegador recusa o DTLS se o certificado não bater com o SDP.
// Estrito de propósito: o navegador aceita a=fingerprint em qualquer caixa e outros algoritmos e
// usa a última linha da seção. Só vale se TODA linha a=fingerprint for sha-256 com o mesmo valor;
// qualquer linha extra, isca ou algoritmo diferente devolve null.
const fpUnico = sdp => {
  const vals = sdp.split(/\r?\n/).filter(l => /^a=fingerprint:/i.test(l))
    .map(l => /^a=fingerprint:sha-256 ([0-9a-f]{2}(?::[0-9a-f]{2}){31})\s*$/i.exec(l)?.[1].replace(/:/g, '').toLowerCase());
  return vals.length > 0 && vals.every(x => x && x === vals[0]) ? vals[0] : null;
};
const confere = (sdp, esperado) => !!esperado && fpUnico(sdp) === esperado;
const comCertificado = async () => {
  const cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
  const fp = cert.getFingerprints().find(f => f.algorithm === 'sha-256').value.replace(/:/g, '').toLowerCase();
  // Mantém os servidores STUN/TURN padrão do PeerJS e só acrescenta o certificado.
  return { fp, config: { ...peerjs.util.defaultConfig, certificates: [cert] } };
};
const novoPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');
const params = new URLSearchParams(location.search);
const sala = params.get('sala'), k = params.get('k');
link.onclick = () => link.select();

let p, s, dc, fim = false, pinAtual = '';
const espectadores = new Set(); // transmissor: conexões que passaram no código
const aoVivo = (sim, txt) => { tally.textContent = txt; tally.classList.toggle('off', !sim); };
// Monta via textContent: nada que vem da rede vira HTML.
const chip = (val, rotulo) => {
  const el = document.createElement('span');
  el.className = 'chip';
  if (rotulo) el.append(rotulo + ' ');
  el.append(Object.assign(document.createElement('b'), { textContent: val }));
  return el;
};
const encerra = (msg, botao) => {
  if (fim) return;
  fim = true;
  // Avisa a outra ponta antes de fechar: sem isso quem assiste fica com a imagem congelada.
  for (const c of espectadores) c.open && c.send({ fim: true });
  dc?.open && dc.send({ saiu: true });
  const velho = p;
  setTimeout(() => velho?.destroy(), 300);
  s?.getTracks().forEach(t => t.stop());
  v.srcObject = null;
  aoVivo(false, 'ENCERRADA');
  st.textContent = '';
  caixa.hidden = sair.hidden = aviso.hidden = acesso.hidden = true;
  fimmsg.textContent = msg;
  denovo.textContent = botao;
  fimtela.hidden = !msg;
};
addEventListener('pagehide', () => encerra('', ''));
copiar.onclick = async () => {
  await navigator.clipboard.writeText(link.value);
  copiar.textContent = 'Copiado';
  setTimeout(() => copiar.textContent = 'Copiar link', 1500);
};

// Espectador: entra com o código; o clique em "Assistir" também libera o autoplay com som.
const assistir = async pin => {
  pinAtual = pin;
  fim = false;
  fimtela.hidden = true;
  sair.hidden = false;
  nota.className = '';
  document.body.classList.add('vivo');
  aoVivo(false, 'CONECTANDO');
  st.textContent = 'Conectando…';
  const { config } = await comCertificado();
  const meu = p = new Peer({ config });
  const ativo = () => p === meu && !fim;
  let verificado = false;
  const impostor = () => encerra('Essa conexão não veio de quem criou o link. Seu código não foi enviado.', 'Reconectar');
  meu.on('error', e => ativo() && encerra(e.type === 'peer-unavailable' ? 'A transmissão não está no ar.' : 'Erro de conexão: ' + e.type, 'Reconectar'));
  meu.on('open', () => {
    dc = meu.connect(sala);
    dc.on('open', () => {
      if (!ativo()) return;
      if (!confere(dc.peerConnection.remoteDescription.sdp, k)) return impostor();
      verificado = true;
      dc.send({ pin });
    });
    dc.on('data', d => {
      if (!ativo()) return;
      if (d?.fim) return encerra('A transmissão terminou.', 'Reconectar');
      if (d?.errado || d?.trancada) {
        fim = true;
        meu.destroy();
        document.body.classList.remove('vivo');
        nota.textContent = d.trancada
          ? 'Essa sala não aceita mais ninguém (muitas tentativas erradas). Peça um link novo.'
          : 'Código incorreto. Confira com quem transmite.';
        nota.className = 'erro';
        pinin.select();
      }
    });
  });
  meu.on('call', c => {
    if (c.peer !== sala || !verificado) return c.close();
    c.answer(undefined, { sdpTransform: stereo });
    const pc = c.peerConnection;
    // O vídeo vem numa conexão separada: confere o certificado dela também.
    pc.addEventListener('signalingstatechange', () => {
      if (ativo() && pc.signalingState === 'stable' && !confere(pc.remoteDescription.sdp, k)) impostor();
    });
    c.on('stream', m => ativo() && (v.srcObject = m));
    pc.addEventListener('connectionstatechange', () => {
      if (!ativo()) return;
      const e = pc.connectionState;
      if (e === 'connected') {
        aoVivo(true, 'AO VIVO');
        st.replaceChildren(chip('verificada', 'Conexão'));
      } else if (e === 'disconnected') {
        aoVivo(false, 'SINAL FRACO');
        st.textContent = 'Tentando recuperar a conexão…';
      } else if (e === 'failed' || e === 'closed') {
        encerra('A conexão caiu.', 'Reconectar');
      }
    });
  });
};

// Transmissor: quem entra abre uma conexão de dados e manda o código; se bater, ligamos com a tela.
const transmitir = async () => {
  const cfg = PRESETS[document.querySelector('input[name=q]:checked').value];
  try {
    s = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: cfg.w }, height: { ideal: cfg.h }, frameRate: { ideal: cfg.fps } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch { return; } // Cancelou a janela de escolha da tela.
  // contentHint faz o Chrome priorizar nitidez (detail) ou fluidez (motion) quando a banda aperta.
  s.getVideoTracks()[0].contentHint = cfg.hint;
  s.getVideoTracks()[0].onended = () => encerra('Você parou de compartilhar.', 'Voltar ao início');
  aviso.hidden = s.getAudioTracks().length > 0;
  v.srcObject = s;
  v.muted = true;
  document.body.classList.add('vivo');
  aoVivo(true, 'AO VIVO');
  // Link e código novos a cada transmissão: um link fixo deixaria quem o tem registrar a mesma sala
  // enquanto você está fora e colher o código de quem tenta reconectar.
  const pin = novoPin();
  acesso.replaceChildren(chip(pin, 'Código de acesso'));

  // Mostra quantos assistem: link vazado aparece como gente a mais.
  let erros = 0;
  const LIMITE = 10; // tentativas erradas até a sala parar de aceitar gente nova
  const status = () => {
    if (fim) return; // destroy() fecha as conexões e dispara 'close' depois do encerramento.
    const n = espectadores.size;
    st.textContent = n ? n + (n > 1 ? ' pessoas assistindo' : ' pessoa assistindo') : 'Ninguém assistindo ainda';
    if (erros >= LIMITE) st.append(' · sala trancada: ' + erros + ' tentativas com código errado. Volte ao início para gerar link e código novos.');
    else if (erros) st.append(' · ' + erros + (erros > 1 ? ' tentativas' : ' tentativa') + ' com código errado');
  };
  const { fp, config } = await comCertificado();
  const meu = p = new Peer({ config });
  meu.on('open', id => {
    link.value = location.href.split('?')[0] + '?sala=' + id + '&k=' + fp;
    copiar.disabled = false;
    status();
  });
  // Queda só do servidor de sinalização não derruba quem já assiste; reconecta mantendo o link.
  meu.on('disconnected', () => !fim && !meu.destroyed && meu.reconnect());
  meu.on('error', e => st.textContent = 'Erro de conexão: ' + e.type);
  // Teto de conexões que ainda não mandaram o código: quem tem o link não enche a memória de pendentes.
  let pendentes = 0;
  meu.on('connection', c => {
    if (pendentes >= 20) return c.close();
    pendentes++;
    let tentou = false, pendente = true, chamada;
    const libera = () => { if (pendente) { pendente = false; pendentes--; } };
    // Fechar o canal de dados derruba também o vídeo: ninguém some da lista e continua assistindo.
    c.on('close', () => { libera(); chamada?.close(); espectadores.delete(c); status(); });
    // Quem conecta e não manda o código em 10 s é derrubado.
    setTimeout(() => !tentou && c.close(), 10000);
    c.on('data', d => {
      if (d?.saiu) return c.close();
      if (tentou) return;
      tentou = true; // uma tentativa por conexão: força bruta exige uma conexão WebRTC nova a cada chute
      libera();
      if (erros >= LIMITE || typeof d?.pin !== 'string' || d.pin !== pin) {
        if (erros < LIMITE) erros++;
        status();
        c.send(erros >= LIMITE ? { trancada: true } : { errado: true });
        return setTimeout(() => c.close(), 500);
      }
      espectadores.add(c);
      status();
      // O código chegou por esta conexão, então o certificado dela é o de quem digitou. O vídeo só
      // sai se a conexão de vídeo tiver o mesmo certificado: alguém no meio não recebe a tela.
      const dele = fpUnico(c.peerConnection.remoteDescription.sdp);
      if (!dele) return c.close();
      chamada = meu.call(c.peer, s, { sdpTransform: stereo });
      const pc = chamada.peerConnection;
      pc.addEventListener('signalingstatechange', () => {
        if (pc.signalingState === 'stable' && !confere(pc.remoteDescription.sdp, dele)) c.close();
      });
      pc.addEventListener('connectionstatechange', () => {
        const e = pc.connectionState;
        if (e === 'failed' || e === 'closed') return c.close();
        if (e !== 'connected') return;
        // O teto padrão do WebRTC para tela é baixo; sobe o maxBitrate do vídeo depois de conectar.
        for (const snd of pc.getSenders()) {
          if (snd.track?.kind !== 'video') continue;
          const prm = snd.getParameters();
          prm.encodings[0].maxBitrate = cfg.mbps * 1e6;
          snd.setParameters(prm);
        }
      });
    });
  });
};

if (sala) {
  sub.textContent = 'Você foi convidado para assistir uma tela ao vivo.';
  nota.textContent = 'Só imagem e som. Ninguém vê nem ouve você.';
  go.textContent = 'Assistir';
  sair.textContent = 'Sair';
  q.hidden = caixa.hidden = acesso.hidden = true;
  campo.hidden = false;
  pinin.required = true;
  pinin.focus();
  if (!/^[0-9a-f]{64}$/.test(k || '')) {
    nota.textContent = 'Link incompleto. Peça o link de novo para quem transmite.';
    nota.className = 'erro';
    go.disabled = true;
  }
  denovo.onclick = () => assistir(pinAtual);
  sair.onclick = () => encerra('Você saiu da transmissão.', 'Reconectar');
} else {
  // Voltar ao início = recarregar; a próxima transmissão sai com link e código novos.
  denovo.onclick = () => location.reload();
  inicio.hidden = false;
  inicio.onclick = () => { encerra('', ''); setTimeout(() => location.reload(), 350); };
  sair.onclick = () => encerra('Transmissão encerrada.', 'Voltar ao início');
}
lobby.onsubmit = e => {
  e.preventDefault();
  sala ? assistir(pinin.value) : transmitir();
};
