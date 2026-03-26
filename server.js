const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const PRESENTER_PIN = process.env.PRESENTER_PIN || '5678';

// ── Diretório de dados persistentes ──────────────────────────────────────────
// Se existir um Volume no Railway montado em /data, usa ele. Senão, usa local.
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');

// Garante que os diretórios existem
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Carregar questões salvas ──────────────────────────────────────────────────
function loadQuestions() {
  try {
    if (fs.existsSync(QUESTIONS_FILE)) {
      const raw = fs.readFileSync(QUESTIONS_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Erro ao carregar questions.json:', e.message);
  }
  return [];
}

function saveQuestions(questions) {
  try {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2), 'utf8');
  } catch (e) {
    console.error('Erro ao salvar questions.json:', e.message);
  }
}

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `q_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 150 * 1024 * 1024 } });

// ── Estado global (em memória) ────────────────────────────────────────────────
const state = {
  questions: loadQuestions(),  // carrega do disco ao iniciar
  phase: 'lobby',
  currentIndex: -1,
  participants: {},
  answers: {},
  questionStartedAt: null,
};

console.log(`Questões carregadas: ${state.questions.length}`);

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploads do diretório de dados (pode ser /data/uploads)
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Rotas amigáveis ───────────────────────────────────────────────────────────
app.get('/presenter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presenter.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── Admin API ─────────────────────────────────────────────────────────────────

// Verificar PIN
app.post('/api/auth', (req, res) => {
  const { pin, role } = req.body;
  if (role === 'admin' && pin === ADMIN_PIN) return res.json({ ok: true });
  if (role === 'presenter' && pin === PRESENTER_PIN) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

// Upload de questão
app.post('/api/questions', upload.single('media'), (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  const { prompt, options, correctIndex } = req.body;
  const parsedOptions = JSON.parse(options);
  const parsedCorrect = parseInt(correctIndex, 10);

  const q = {
    id: Date.now().toString(),
    mediaType: req.file ? (req.file.mimetype.startsWith('video') ? 'video' : 'image') : null,
    mediaUrl: req.file ? `/uploads/${req.file.filename}` : null,
    prompt,
    options: parsedOptions.map((label, i) => ({ label, correct: i === parsedCorrect })),
  };
  state.questions.push(q);
  saveQuestions(state.questions);
  res.json({ ok: true, question: q });
});

// Listar questões
app.get('/api/questions', (req, res) => {
  if (req.query.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  res.json(state.questions);
});

// Deletar questão
app.delete('/api/questions/:id', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  const idx = state.questions.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  const [removed] = state.questions.splice(idx, 1);
  if (removed.mediaUrl) {
    const filePath = path.join(UPLOADS_DIR, path.basename(removed.mediaUrl));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  saveQuestions(state.questions);
  res.json({ ok: true });
});

// Reordenar questões
app.post('/api/questions/reorder', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  const { ids } = req.body;
  state.questions = ids.map(id => state.questions.find(q => q.id === id)).filter(Boolean);
  saveQuestions(state.questions);
  res.json({ ok: true });
});

// Resetar tudo (para novo quiz)
app.post('/api/reset', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  state.phase = 'lobby';
  state.currentIndex = -1;
  state.answers = {};
  state.questionStartedAt = null;
  state.participants = {};
  io.emit('kicked'); // manda todo mundo de volta pra tela de nome
  io.emit('state', buildPublicState());
  res.json({ ok: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildPublicState() {
  const q = state.currentIndex >= 0 ? state.questions[state.currentIndex] : null;
  return {
    phase: state.phase,
    currentIndex: state.currentIndex,
    totalQuestions: state.questions.length,
    question: q ? {
      id: q.id,
      mediaType: q.mediaType,
      mediaUrl: q.mediaUrl,
      prompt: q.prompt,
      optionLabels: q.options.map(o => o.label),
      // Correct só vai no reveal
      correctIndex: state.phase === 'reveal' ? q.options.findIndex(o => o.correct) : null,
    } : null,
    participantCount: Object.keys(state.participants).length,
  };
}

function buildRanking() {
  return Object.entries(state.participants)
    .map(([sid, p]) => ({ name: p.name, score: p.score, totalMs: p.totalMs }))
    .sort((a, b) => b.score - a.score || a.totalMs - b.totalMs)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

function buildPresenterExtra() {
  // Distribuição de respostas da questão atual
  if (state.currentIndex < 0) return {};
  const q = state.questions[state.currentIndex];
  const counts = q.options.map(() => 0);
  let total = 0;
  Object.keys(state.answers).forEach(key => {
    if (key.endsWith(`_${state.currentIndex}`)) {
      const { optionIndex } = state.answers[key];
      if (optionIndex != null) { counts[optionIndex]++; total++; }
    }
  });
  return { answerCounts: counts, answerTotal: total, participantCount: Object.keys(state.participants).length };
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Participante entra ──────────────────────────────────────────────────────
  socket.on('join', ({ name }) => {
    if (!name || name.trim().length < 2) return;
    // Re-join por nome (reconexão)
    const existing = Object.entries(state.participants).find(([sid, p]) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (existing) {
      const [oldSid, data] = existing;
      if (oldSid !== socket.id) {
        state.participants[socket.id] = data;
        delete state.participants[oldSid];
        // Remapear respostas
        Object.keys(state.answers).forEach(key => {
          if (key.startsWith(oldSid + '_')) {
            state.answers[socket.id + '_' + key.split('_')[1]] = state.answers[key];
            delete state.answers[key];
          }
        });
      }
    } else {
      state.participants[socket.id] = { name: name.trim(), score: 0, totalMs: 0, answers: [] };
    }

    socket.emit('joined', buildPublicState());
    io.to('presenter').emit('presenterExtra', buildPresenterExtra());
  });

  // ── Resposta do participante ────────────────────────────────────────────────
  socket.on('answer', ({ optionIndex }) => {
    const p = state.participants[socket.id];
    if (!p || state.phase !== 'question' || state.currentIndex < 0) return;
    const key = `${socket.id}_${state.currentIndex}`;
    if (state.answers[key]) return; // já respondeu

    const ms = Date.now() - state.questionStartedAt;
    const q = state.questions[state.currentIndex];
    const correct = q.options[optionIndex]?.correct || false;

    state.answers[key] = { optionIndex, ms, correct };
    if (correct) { p.score++; p.totalMs += ms; }

    socket.emit('answerAck', { correct: null }); // não revela ainda
    io.to('presenter').emit('presenterExtra', buildPresenterExtra());
  });

  // ── Presenter entra ─────────────────────────────────────────────────────────
  socket.on('presenterJoin', ({ pin }) => {
    if (pin !== PRESENTER_PIN) return socket.emit('presenterError', 'PIN inválido');
    socket.join('presenter');
    socket.emit('presenterState', { ...buildPublicState(), ...buildPresenterExtra(), ranking: buildRanking(), questions: state.questions });
  });

  // ── Controles do presenter ──────────────────────────────────────────────────
  socket.on('cmd', ({ pin, action }) => {
    if (pin !== PRESENTER_PIN) return;

    if (action === 'next') {
      if (state.questions.length === 0) return;
      const nextIndex = state.currentIndex + 1;
      if (nextIndex >= state.questions.length) {
        // Encerrar: vai pra fase 'finished' — ranking só aparece quando você mandar
        state.phase = 'finished';
        state.currentIndex = state.questions.length - 1;
        io.emit('state', buildPublicState()); // celulares veem tela de "aguarde"
        io.to('presenter').emit('presenterState', { ...buildPublicState(), ...buildPresenterExtra(), ranking: buildRanking(), questions: state.questions });
        return;
      }
      state.currentIndex = nextIndex;
      state.phase = 'question';
      state.questionStartedAt = Date.now();
      io.emit('state', buildPublicState());
      io.to('presenter').emit('presenterState', { ...buildPublicState(), ...buildPresenterExtra(), ranking: buildRanking(), questions: state.questions });
    }

    if (action === 'ranking') {
      if (state.phase !== 'finished') return;
      state.phase = 'ranking';
      const ranking = buildRanking();
      io.emit('state', { ...buildPublicState(), ranking });
      io.to('presenter').emit('presenterState', { ...buildPublicState(), ...buildPresenterExtra(), ranking, questions: state.questions });
    }

    if (action === 'reveal') {
      if (state.phase !== 'question') return;
      state.phase = 'reveal';
      // Calcular tempo dos que não responderam: não penalizar, apenas não somam
      const publicState = buildPublicState();
      const answerCounts = buildPresenterExtra();
      // Revelar resposta correta para participantes
      io.emit('state', publicState);
      io.to('presenter').emit('presenterState', { ...publicState, ...answerCounts, ranking: buildRanking(), questions: state.questions });
    }

    if (action === 'lobby') {
      state.phase = 'lobby';
      state.currentIndex = -1;
      state.answers = {};
      state.questionStartedAt = null;
      state.participants = {};
      io.emit('kicked'); // manda todo mundo de volta pra tela de nome
      io.emit('state', buildPublicState());
      io.to('presenter').emit('presenterState', { ...buildPublicState(), ...buildPresenterExtra(), ranking: [], questions: state.questions });
    }
  });

  // ── Desconexão ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    // Não remove o participante: pode reconectar. Presenter apenas sai da room.
    io.to('presenter').emit('presenterExtra', buildPresenterExtra());
  });
});

server.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));