require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const nodemailer = require('nodemailer');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');
const archiver = require('archiver');
const unzipper = require('unzipper');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => {
    console.error('Error en pool PostgreSQL:', err.message);
});

const BACKUP_DIR = path.join(__dirname, 'backups');
['./backups', './backups/temp'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const backupStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, './backups/temp/'),
    filename: (req, file, cb) => cb(null, 'restore_' + Date.now() + path.extname(file.originalname))
});
const uploadBackup = multer({ storage: backupStorage, limits: { fileSize: 500 * 1024 * 1024 } });

async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_variantes_productoid ON variantes("productoId");
            CREATE INDEX IF NOT EXISTS idx_productos_orden ON productos(orden ASC, id DESC);
        `).catch(()=>{});
        await client.query(`
            CREATE TABLE IF NOT EXISTS productos (
                id BIGINT PRIMARY KEY,
                nombre TEXT NOT NULL,
                precio REAL NOT NULL DEFAULT 0,
                "precioMayor" REAL DEFAULT 0,
                descripcion TEXT DEFAULT '',
                "categoriaId" INTEGER,
                subcategoria TEXT DEFAULT '',
                "fechaCreacion" TEXT DEFAULT NOW(),
                destacado INTEGER DEFAULT 0,
                orden INTEGER DEFAULT 0
);
            CREATE TABLE IF NOT EXISTS variantes (
                id SERIAL PRIMARY KEY,
                "productoId" BIGINT NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
                nombre TEXT NOT NULL,
                stock INTEGER DEFAULT 0,
                foto TEXT DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS categorias (
                id BIGINT PRIMARY KEY,
                nombre TEXT NOT NULL,
                subcategorias TEXT DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS usuarios (
                id TEXT PRIMARY KEY,
                nombre TEXT NOT NULL DEFAULT '',
                apellido TEXT NOT NULL DEFAULT '',
                email TEXT UNIQUE NOT NULL,
                telefono TEXT DEFAULT '',
                dni TEXT DEFAULT '',
                password TEXT,
                "googleId" TEXT,
                foto TEXT DEFAULT '',
                rol TEXT DEFAULT 'cliente',
                "resetPin" TEXT,
                "resetPinExpires" BIGINT,
                "fechaRegistro" TEXT DEFAULT NOW(),
                direccion TEXT DEFAULT '',
                provincia TEXT DEFAULT '',
                localidad TEXT DEFAULT '',
                cp TEXT DEFAULT '',
                "datosCompletos" INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS ventas (
                id TEXT PRIMARY KEY,
                fecha TEXT,
                "fechaTimestamp" BIGINT,
                items TEXT DEFAULT '[]',
                total REAL DEFAULT 0,
                "metodoPago" TEXT DEFAULT 'efectivo',
                logistica TEXT DEFAULT 'local',
                cliente TEXT DEFAULT '{}',
                "esMayorista" INTEGER DEFAULT 0,
                "razonMayorista" TEXT DEFAULT '',
                estado TEXT DEFAULT 'completada',
                origen TEXT DEFAULT 'admin',
                "pedidoId" TEXT
            );
            CREATE TABLE IF NOT EXISTS pedidos (
                id TEXT PRIMARY KEY,
                fecha TEXT,
                "fechaTimestamp" BIGINT,
                items TEXT DEFAULT '[]',
                total REAL DEFAULT 0,
                cliente TEXT DEFAULT '{}',
                "tipoEntrega" TEXT DEFAULT 'local',
                "metodoEnvio" TEXT DEFAULT '',
                "esMayorista" INTEGER DEFAULT 0,
                "razonMayorista" TEXT DEFAULT '',
                estado TEXT DEFAULT 'pendiente',
                origen TEXT DEFAULT 'tienda',
                pin TEXT,
                "ventaId" TEXT,
                "usuarioId" TEXT,
                "stockDescontado" INTEGER DEFAULT 1,
                "fechaCancelado" TEXT,
                "fechaAbonado" TEXT,
                "fechaEnviado" TEXT,
                "fechaEntregado" TEXT
            );
            CREATE TABLE IF NOT EXISTS notificaciones (
                id TEXT PRIMARY KEY,
                tipo TEXT,
                titulo TEXT,
                descripcion TEXT,
                fecha TEXT,
                leida INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS configuracion (
                clave TEXT PRIMARY KEY,
                valor TEXT
            );
            CREATE TABLE IF NOT EXISTS metodos_envio (
                id SERIAL PRIMARY KEY,
                nombre TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS logs_admin (
                id TEXT PRIMARY KEY,
                admin TEXT,
                accion TEXT,
                detalles TEXT,
                ip TEXT,
                fecha TEXT DEFAULT NOW(),
                "fechaLocal" TEXT
            );
            CREATE TABLE IF NOT EXISTS perfiles (
                id TEXT PRIMARY KEY,
                usuario TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                nombre TEXT NOT NULL,
                rol TEXT DEFAULT 'vendedor',
                permisos TEXT DEFAULT '[]',
                activo INTEGER DEFAULT 1,
                "fechaCreacion" TEXT DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS caja_diaria (
                fecha TEXT PRIMARY KEY,
                "montoInicial" REAL DEFAULT 0,
                "abiertaPor" TEXT,
                "cerradaPor" TEXT,
                estado TEXT DEFAULT 'cerrada',
                "aperturaTimestamp" BIGINT,
                "cierreTimestamp" BIGINT,
                "totalVentas" REAL DEFAULT 0,
                "totalEsperado" REAL DEFAULT 0,
                "detallePagos" TEXT DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS caja_profesional (
                fecha TEXT PRIMARY KEY,
                "aperturaTimestamp" BIGINT,
                "abiertaPor" TEXT,
                "cerradaPor" TEXT,
                "montoInicialEfectivo" REAL DEFAULT 0,
                "montoInicialTransferencia" REAL DEFAULT 0,
                "ventasEfectivo" REAL DEFAULT 0,
                "ventasTransferencia" REAL DEFAULT 0,
                "ventasWebTransferencia" REAL DEFAULT 0,
                "efectivoEntregado" REAL DEFAULT 0,
                "transferenciaEntregada" REAL DEFAULT 0,
                "totalEsperadoEfectivo" REAL DEFAULT 0,
                "totalEsperadoTransferencia" REAL DEFAULT 0,
                "diferenciaEfectivo" REAL DEFAULT 0,
                "diferenciaTransferencia" REAL DEFAULT 0,
                "cantidadVentas" INTEGER DEFAULT 0,
                estado TEXT DEFAULT 'cerrada',
                "cierreTimestamp" BIGINT
            );
            CREATE TABLE IF NOT EXISTS costos_productos (
                id TEXT PRIMARY KEY,
                "productoId" BIGINT NOT NULL,
                "costoBase" REAL DEFAULT 0,
                "costoEnvio" REAL DEFAULT 0,
                "gastosAdicionales" TEXT DEFAULT '[]',
                "costoTotal" REAL DEFAULT 0,
                "fechaTimestamp" BIGINT,
                "fechaCreacion" TEXT DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS turnos_caja (
                id TEXT PRIMARY KEY,
                "perfilId" TEXT, "perfilNombre" TEXT,
                "perfilCierreId" TEXT, "perfilCierreNombre" TEXT,
                "fechaApertura" TEXT, "fechaCierre" TEXT,
                "timestampApertura" BIGINT, "timestampCierre" BIGINT,
                "efectivoInicial" REAL DEFAULT 0,
                "entregaEfectivo" REAL DEFAULT 0,
                "entregaTransferencia" REAL DEFAULT 0,
                estado TEXT DEFAULT 'abierto'
            );
            CREATE TABLE IF NOT EXISTS gastos_caja (
                id TEXT PRIMARY KEY, "turnoId" TEXT,
                descripcion TEXT, monto REAL DEFAULT 0,
                fecha TEXT, "fechaTimestamp" BIGINT
            );
        `);
        console.log('✅ PostgreSQL listo');
    } finally {
        client.release();
    }
}

const configInicial = {
    logo: '', empresa: JSON.stringify({ nombre: "Casa Elegida", telefono: "", email: "casaelegida20@gmail.com", direccion: "" }),
    horarios: JSON.stringify({ lunesViernes: "9:00 - 13:00 y 17:00 - 20:00", sabados: "9:00 - 13:00", domingos: "Cerrado" }),
    redes: JSON.stringify({ instagram: "", facebook: "", tiktok: "", whatsapp: "" }),
    pagos: JSON.stringify({ alias: "", cbu: "", banco: "", titular: "" }),
    mayorista: JSON.stringify({ habilitado: false, modo: "cantidad", valorCantidad: 3, valorMonto: 80000 }),
    tienda: JSON.stringify({ habilitada: true, titulo: "Casa Elegida", mensajeBienvenida: "Calidad y confort", retiroLocal: true }),
    diseno: JSON.stringify({ colorPrimario: "#1a1a1a", colorSecundario: "#c9a96e", colorFondo: "#fafafa", colorTexto: "#1a1a1a" }),
    registroObligatorio: 'true',
    heroConfig: JSON.stringify({ titulo: "Casa Elegida", subtitulo: "Blanquería premium", badge: "✦ Precios especiales" }),
    seccionesDestacadas: JSON.stringify([{ id: "dest-1", titulo: "Novedades", tipo: "categoria", valor: "Toallones", limite: 4 }]),
    plantilla: 'moderna',
    icono: 'store'
};

async function initConfig() {
    for (const [k, v] of Object.entries(configInicial)) {
        await pool.query('INSERT INTO configuracion (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING', [k, v]);
    }
}

async function initMetodosEnvio() {
    const existe = await pool.query('SELECT COUNT(*) as c FROM metodos_envio');
    if (parseInt(existe.rows[0].c) === 0) {
        const metodos = ['Via Cargo', 'Correo Argentino', 'Andreani', 'Moto Mensajería'];
        for (const m of metodos) {
            await pool.query('INSERT INTO metodos_envio (nombre) VALUES ($1)', [m]);
        }
    }
}

async function initAdmin() {
    const existe = await pool.query("SELECT id FROM perfiles WHERE usuario = 'admin'");
    if (existe.rows.length === 0) {
        const passwordInicial = process.env.ADMIN_INITIAL_PASSWORD;
        if (!passwordInicial) {
            console.error('❌ No se creó el perfil admin: falta definir la variable de entorno ADMIN_INITIAL_PASSWORD');
            return;
        }
        const hp = bcrypt.hashSync(passwordInicial, 10);
        await pool.query('INSERT INTO perfiles (id, usuario, password, nombre, rol, permisos) VALUES ($1, $2, $3, $4, $5, $6)',
            ['PERF-' + Date.now(), 'admin', hp, 'Administrador Principal', 'admin', '[]']);
        console.log('✅ Admin creado');
    }
}

async function getConfig() {
    const result = await pool.query('SELECT clave, valor FROM configuracion');
    const config = {};
    result.rows.forEach(r => {
        try { config[r.clave] = JSON.parse(r.valor); } catch(e) { config[r.clave] = r.valor; }
    });
    if (!config.banners) config.banners = [];
    if (!config.anuncios) config.anuncios = [];
    return config;
}

async function setConfig(k, v) {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    await pool.query('INSERT INTO configuracion (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = $2', [k, val]);
}

async function getEmpresa() {
    const c = await getConfig();
    return typeof c.empresa === 'string' ? JSON.parse(c.empresa) : (c.empresa || { nombre: 'Casa Elegida' });
}

async function logActividad(admin, accion, detalles, req) {
    try {
        const id = 'LOG-' + Date.now();
        const ip = req?.ip || 'localhost';
        const fecha = new Date().toISOString();
        const fechaLocal = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        await pool.query('INSERT INTO logs_admin (id, admin, accion, detalles, ip, fecha, "fechaLocal") VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [id, admin || 'Sistema', accion, String(detalles).substring(0, 200), ip, fecha, fechaLocal]);
    } catch(e) {}
}

async function crearNotificacion(tipo, titulo, desc) {
    await pool.query("INSERT INTO notificaciones (id, tipo, titulo, descripcion, fecha, leida) VALUES ($1,$2,$3,$4,NOW(),0)",
        ['NOTIF-' + Date.now(), tipo, titulo, desc]);
}

async function enviarEmail(dest, asunto, html) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return false;
    try {
        await transporter.sendMail({ from: `"${(await getEmpresa()).nombre}" <${process.env.EMAIL_USER}>`, to: dest, subject: asunto, html });
        return true;
    } catch(e) { return false; }
}

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
const JWT_SECRET = process.env.JWT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'casa-elegida-session-secret';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://casaelegida.com.ar/auth/google/callback';
const fmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0 });

['./uploads', './public', './backups', './backups/temp'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
const storage = multer.diskStorage({ destination: (req, f, cb) => cb(null, './uploads/'), filename: (req, f, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(f.originalname)) });
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, f, cb) => { const a = /jpeg|jpg|png|gif|webp/; cb(null, a.test(path.extname(f.originalname).toLowerCase()) && a.test(f.mimetype)); } });

app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({ 
    secret: SESSION_SECRET, 
    resave: false, 
    saveUninitialized: false, 
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000,
        secure: false,
        sameSite: 'lax'
    } 
}));
app.use(passport.initialize()); 
app.use(passport.session());
app.use('/uploads', express.static('uploads')); 
app.use(express.static('public'));

passport.use(new GoogleStrategy({ 
    clientID: GOOGLE_CLIENT_ID, 
    clientSecret: GOOGLE_CLIENT_SECRET, 
    callbackURL: CALLBACK_URL
},
    async (accessToken, refreshToken, profile, done) => {
        try {
            console.log('🔵 Google login:', profile.emails[0].value);
            const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [profile.emails[0].value]);
            let u = result.rows[0];
            if (!u) {
                const id = 'USR-' + Date.now();
                await pool.query(
                    'INSERT INTO usuarios (id, nombre, apellido, email, "googleId", foto, rol, "datosCompletos") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                    [id, profile.name?.givenName || '', profile.name?.familyName || '', 
                     profile.emails[0].value, profile.id, profile.photos?.[0]?.value || '', 'cliente', 0]  // ← Cambiado de 1 a 0
                );
                const newResult = await pool.query('SELECT * FROM usuarios WHERE id = $1', [id]);
                u = newResult.rows[0];
                console.log('✅ Usuario creado:', u.email);
            } else {
                console.log('✅ Usuario existente:', u.email);
            }
            return done(null, u);
        } catch(e) { 
            console.error('❌ Error Google Strategy:', e.message);
            return done(e, null); 
        }
    }
));

passport.serializeUser((user, done) => { done(null, user.id); });

passport.deserializeUser(async (id, done) => {
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE id = $1', [id]);
        done(null, result.rows[0] || null);
    } catch(e) { done(e, null); }
});

const authMiddleware = (req, res, next) => { 
    const t = req.headers.authorization?.replace('Bearer ', ''); 
    if (!t) return res.status(401).json({ error: 'No autorizado' }); 
    try { req.usuario = jwt.verify(t, JWT_SECRET); next(); } 
    catch(e) { res.status(401).json({ error: 'Token inválido' }); } 
};

const adminMiddleware = (permiso = null) => (req, res, next) => { 
    const t = req.headers.authorization?.replace('Bearer ', ''); 
    if (!t) return res.status(401).json({ error: 'No autorizado' }); 
    try { 
        const d = jwt.verify(t, JWT_SECRET); 
        if (d.tipo !== 'admin') return res.status(401).json({ error: 'No autorizado' }); 
        if (d.rol === 'admin') { req.admin = d; return next(); } 
        if (permiso && !d.permisos.includes(permiso)) return res.status(403).json({ error: 'Sin permiso' }); 
        req.admin = d; next(); 
    } catch(e) { res.status(401).json({ error: 'Token inválido' }); } 
};

const generarPIN = () => Math.floor(1000 + Math.random() * 9000).toString();

['admin','tienda','checkout','login','registro','perfil','recuperar','mis-pedidos','completar-datos'].forEach(p => 
    app.get('/' + p, (req, res) => res.sendFile(path.join(__dirname, 'public', p + '.html')))
);

app.get('/', (req, res) => res.redirect('/tienda'));

// 1. Ruta para que cuando entren a /producto/12345 sirva la nueva interfaz dedicada
app.get('/producto/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'producto.html'));
});

// 2. Endpoint API para traer de manera ultra rápida los datos de UN solo producto con sus variantes
app.get('/api/tienda/producto/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const prodResult = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
        const p = prodResult.rows[0];
        
        if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
        
        // Traemos sus variantes reales asociadas
        p.variantes = (await pool.query('SELECT * FROM variantes WHERE "productoId"=$1 ORDER BY id ASC', [p.id])).rows;
        
        // Traemos la configuración global para el tema de los colores y reglas mayoristas
        const resultConfig = await pool.query('SELECT clave, valor FROM configuracion');
        const config = {};
        resultConfig.rows.forEach(r => {
            try { config[r.clave] = JSON.parse(r.valor); } catch(e) { config[r.clave] = r.valor; }
        });

        res.json({ producto: p, configuracion: config });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/login?error=google' }),
    async (req, res) => {
        try {
            if (!req.user) return res.redirect('/login?error=nouser');
            const token = jwt.sign({ id: req.user.id, email: req.user.email, nombre: req.user.nombre, rol: req.user.rol }, JWT_SECRET, { expiresIn: '7d' });
            const datosCompletos = parseInt(req.user.datosCompletos);
            const returnUrl = (datosCompletos === 0 || isNaN(datosCompletos)) ? '/completar-datos' : '/tienda';
            res.send(`
                <!DOCTYPE html><html><head><meta charset="utf-8"><title>Redirigiendo...</title>
                <script>
                    localStorage.setItem('token', '${token}');
                    localStorage.setItem('usuario', JSON.stringify({id:'${req.user.id}',nombre:'${req.user.nombre||''}',apellido:'${req.user.apellido||''}',email:'${req.user.email}'}));
                    window.location.href = '${returnUrl}';
                </script></head><body><p>Redirigiendo...</p></body></html>`);
        } catch(e) { console.error('❌ Error en callback:', e); res.redirect('/login?error=server'); }
    }
);

app.post('/admin/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const p = (await pool.query('SELECT * FROM perfiles WHERE usuario = $1 AND activo = 1', [usuario])).rows[0];
        if (!p) return res.status(401).json({ error: 'Usuario no encontrado' });
        if (!(await bcrypt.compare(password, p.password))) return res.status(401).json({ error: 'Contraseña incorrecta' });
        await logActividad(p.nombre, 'LOGIN_ADMIN', 'Inicio de sesión', req);
        res.json({ success: true, token: jwt.sign({ id: p.id, usuario: p.usuario, nombre: p.nombre, rol: p.rol, permisos: JSON.parse(p.permisos||'[]'), tipo: 'admin' }, JWT_SECRET, { expiresIn: '7d' }), perfil: { id: p.id, usuario: p.usuario, nombre: p.nombre, rol: p.rol, permisos: JSON.parse(p.permisos||'[]') } });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/cambiar-password', adminMiddleware(), async (req, res) => {
    try {
        const { passwordActual, passwordNueva } = req.body;
        if (!passwordActual || !passwordNueva || passwordNueva.length < 6) return res.status(400).json({ error: 'Datos inválidos' });
        const p = (await pool.query('SELECT * FROM perfiles WHERE id = $1', [req.admin.id])).rows[0];
        if (!p) return res.status(404).json({ error: 'Perfil no encontrado' });
        if (!(await bcrypt.compare(passwordActual, p.password))) return res.status(401).json({ error: 'Contraseña incorrecta' });
        await pool.query('UPDATE perfiles SET password = $1 WHERE id = $2', [await bcrypt.hash(passwordNueva, 10), req.admin.id]);
        await logActividad(req.admin.nombre, 'CAMBIO_PASSWORD', 'Cambió su contraseña', req);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/perfiles', adminMiddleware(), async (req, res) => {
    const perfiles = (await pool.query('SELECT id, usuario, nombre, rol, permisos, activo FROM perfiles ORDER BY "fechaCreacion" DESC')).rows;
    res.json({ lista: perfiles.map(p => ({ ...p, permisos: JSON.parse(p.permisos||'[]') })) });
});

app.post('/admin/crear-perfil', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'No autorizado' });
        let decoded;
        try { decoded = jwt.verify(token, JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Token inválido' }); }
        if (decoded.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
        const { adminPassword, usuario, password, nombre, permisos } = req.body;
        if (!adminPassword || !usuario || !password || !nombre) return res.status(400).json({ error: 'Todos los campos requeridos' });
        const adminPerfil = (await pool.query("SELECT * FROM perfiles WHERE usuario = 'admin'")).rows[0];
        if (!adminPerfil) return res.status(404).json({ error: 'Admin no encontrado' });
        if (!(await bcrypt.compare(adminPassword, adminPerfil.password))) return res.status(401).json({ error: 'Contraseña incorrecta' });
        if ((await pool.query('SELECT id FROM perfiles WHERE usuario = $1', [usuario])).rows.length > 0) return res.status(400).json({ error: 'Usuario ya existe' });
        await pool.query('INSERT INTO perfiles (id, usuario, password, nombre, rol, permisos) VALUES ($1,$2,$3,$4,$5,$6)',
            ['PERF-' + Date.now(), usuario, await bcrypt.hash(password, 10), nombre, 'vendedor', JSON.stringify(permisos||[])]);
        await logActividad(decoded.nombre, 'CREAR_PERFIL', `Creó perfil: ${nombre} (${usuario})`, req);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/editar-perfil', adminMiddleware(), async (req, res) => {
    try {
        const { id, nombre, permisos, activo, password } = req.body;
        const p = (await pool.query('SELECT * FROM perfiles WHERE id = $1', [id])).rows[0];
        if (!p) return res.status(404).json({ error: 'Perfil no encontrado' });
        if (p.rol === 'admin' && req.admin.rol !== 'admin') return res.status(400).json({ error: 'No se puede editar al admin' });
        
        let activoValor = activo;
        if (typeof activo === 'boolean') activoValor = activo ? 1 : 0;
        if (activoValor === undefined || activoValor === null) activoValor = p.activo;
        
        if (password && password.length >= 4) {
            const hash = await bcrypt.hash(password, 10);
            await pool.query('UPDATE perfiles SET nombre=$1, permisos=$2, activo=$3, password=$4 WHERE id=$5',
                [nombre || p.nombre, JSON.stringify(permisos || []), activoValor, hash, id]);
        } else {
            await pool.query('UPDATE perfiles SET nombre=$1, permisos=$2, activo=$3 WHERE id=$4',
                [nombre || p.nombre, JSON.stringify(permisos || []), activoValor, id]);
        }
        await logActividad(req.admin.nombre, 'EDITAR_PERFIL', `Editó perfil: ${nombre || p.nombre}`, req);
        res.json({ success: true });
    } catch(e) { 
        console.error('Error editar-perfil:', e);
        res.status(500).json({ error: e.message }); 
    }
});
app.post('/admin/eliminar-perfil', adminMiddleware(), async (req, res) => {
    try {
        const { id, adminPassword } = req.body;
        const p = (await pool.query('SELECT * FROM perfiles WHERE id = $1', [id])).rows[0];
        if (!p) return res.status(404).json({ error: 'Perfil no encontrado' });
        if (p.rol === 'admin') return res.status(400).json({ error: 'No se puede eliminar al admin' });
        const adminPerfil = (await pool.query("SELECT * FROM perfiles WHERE usuario = $1", [req.admin.usuario])).rows[0];
        if (!(await bcrypt.compare(adminPassword, adminPerfil.password))) return res.status(401).json({ error: 'Contraseña incorrecta' });
        await pool.query('DELETE FROM perfiles WHERE id = $1', [id]);
        await logActividad(req.admin.nombre, 'ELIMINAR_PERFIL', `Perfil eliminado: ${p.nombre} (${p.usuario})`, req);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/registro', async (req, res) => {
    try {
        const { nombre, apellido, email, dni, telefono, provincia, localidad, cp, direccion, password } = req.body;
        if (!nombre || !apellido || !email || !dni || !telefono || !provincia || !localidad || !cp || !direccion || !password) return res.status(400).json({ error: 'Completá todos los campos' });
        if ((await pool.query('SELECT id FROM usuarios WHERE email=$1', [email])).rows.length > 0) return res.status(400).json({ error: 'Email ya registrado' });
        const id = 'USR-' + Date.now();
        await pool.query('INSERT INTO usuarios (id,nombre,apellido,email,dni,telefono,direccion,provincia,localidad,cp,password,rol,"datosCompletos") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1)',
            [id, nombre, apellido, email, dni, telefono, direccion, provincia, localidad, cp, await bcrypt.hash(password, 10), 'cliente']);
        await logActividad('Sistema', 'REGISTRO_CLIENTE', `Nuevo cliente: ${email}`, req);
        res.json({ success: true, token: jwt.sign({ id, email, nombre, rol: 'cliente' }, JWT_SECRET, { expiresIn: '7d' }), usuario: { id, nombre, apellido, email } });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const u = (await pool.query('SELECT * FROM usuarios WHERE email=$1', [email])).rows[0];
        if (!u?.password || !(await bcrypt.compare(password, u.password))) return res.status(401).json({ error: 'Credenciales inválidas' });
        await logActividad('Sistema', 'LOGIN_CLIENTE', `Cliente: ${email}`, req);
        const token = jwt.sign({ id: u.id, email: u.email, nombre: u.nombre, rol: u.rol }, JWT_SECRET, { expiresIn: '7d' });
        if (u.datosCompletos == 0) return res.json({ success: true, token, completarDatos: true, usuario: { id: u.id, nombre: u.nombre, apellido: u.apellido, email: u.email } });
        res.json({ success: true, token, usuario: { id: u.id, nombre: u.nombre, apellido: u.apellido, email: u.email } });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/recuperar', async (req, res) => {
    try {
        const u = (await pool.query('SELECT * FROM usuarios WHERE email=$1', [req.body.email])).rows[0];
        if (!u) return res.status(404).json({ error: 'Email no encontrado' });
        const pin = Math.floor(100000 + Math.random()*900000).toString();
        await pool.query('UPDATE usuarios SET "resetPin"=$1, "resetPinExpires"=$2 WHERE id=$3', [pin, Date.now()+3600000, u.id]);
        await enviarEmail(u.email, 'Recuperación', `<h1>Casa Elegida</h1><p>PIN: <strong>${pin}</strong></p>`);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/reset-password', async (req, res) => {
    try {
        const { email, pin, newPassword } = req.body;
        const u = (await pool.query('SELECT * FROM usuarios WHERE email=$1', [email])).rows[0];
        if (!u || u["resetPin"] !== pin || u["resetPinExpires"] < Date.now()) return res.status(400).json({ error: 'PIN inválido' });
        await pool.query('UPDATE usuarios SET password=$1, "resetPin"=NULL, "resetPinExpires"=NULL WHERE id=$2', [await bcrypt.hash(newPassword, 10), u.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/auth/me', authMiddleware, async (req, res) => {
    const u = (await pool.query('SELECT id,nombre,apellido,email,telefono,dni,direccion,provincia,localidad,cp,"datosCompletos" FROM usuarios WHERE id=$1', [req.usuario.id])).rows[0];
    res.json(u || {});
});

app.post('/auth/update-profile', authMiddleware, async (req, res) => {
    const { telefono, direccion, provincia, localidad, cp } = req.body;
    await pool.query('UPDATE usuarios SET telefono=$1, direccion=$2, provincia=$3, localidad=$4, cp=$5 WHERE id=$6',
        [telefono||'', direccion||'', provincia||'', localidad||'', cp||'', req.usuario.id]);
    res.json({ success: true });
});

app.post('/auth/completar-datos', authMiddleware, async (req, res) => {
    try {
        const u = (await pool.query('SELECT * FROM usuarios WHERE id=$1', [req.usuario.id])).rows[0];
        if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

        const { nombre, apellido, dni, telefono, direccion, provincia, localidad, cp } = req.body;

        if (u.datosCompletos == 0) {
            // Primera vez: guardamos todo incluyendo los campos bloqueados
            if (!nombre || !apellido || !dni || !telefono || !direccion || !provincia || !localidad || !cp)
                return res.status(400).json({ error: 'Todos los campos son obligatorios' });
            await pool.query(
                'UPDATE usuarios SET nombre=$1, apellido=$2, dni=$3, telefono=$4, direccion=$5, provincia=$6, localidad=$7, cp=$8, "datosCompletos"=1 WHERE id=$9',
                [nombre, apellido, dni, telefono, direccion, provincia, localidad, cp, u.id]
            );
        } else {
            // Ya completó datos: solo actualizamos los campos permitidos
            if (!telefono || !provincia || !localidad || !cp || !direccion)
                return res.status(400).json({ error: 'Completá todos los campos editables' });
            await pool.query(
                'UPDATE usuarios SET telefono=$1, direccion=$2, provincia=$3, localidad=$4, cp=$5 WHERE id=$6',
                [telefono, direccion, provincia, localidad, cp, u.id]
            );
        }

        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/listar', async (req, res) => {
    const [prodsResult, variantesResult] = await Promise.all([
        pool.query('SELECT * FROM productos ORDER BY orden ASC, id DESC'),
        pool.query('SELECT * FROM variantes ORDER BY "productoId", id ASC')
    ]);
    const prods = prodsResult.rows;
    const varMap = {};
    variantesResult.rows.forEach(v => {
        if (!varMap[v.productoId]) varMap[v.productoId] = [];
        varMap[v.productoId].push(v);
    });
    prods.forEach(p => { p.variantes = varMap[p.id] || []; });
    res.json({ lista: prods });
});

app.post('/guardar-producto', async (req, res) => {
    const client = await pool.connect();
    try {
        const p = req.body;
        if (!p.nombre?.trim() || p.precio <= 0) { client.release(); return res.status(400).json({ error: 'Datos inválidos' }); }
        await client.query('BEGIN');
        const existe = (await client.query('SELECT id FROM productos WHERE id=$1', [p.id])).rows[0];
        if (existe) {
            await client.query('UPDATE productos SET nombre=$1,precio=$2,"precioMayor"=$3,descripcion=$4,"categoriaId"=$5,subcategoria=$6,destacado=$7 WHERE id=$8',
                [p.nombre, p.precio, p.precioMayor||0, p.descripcion||'', p.categoriaId ? parseInt(p.categoriaId) : null, p.subcategoria||'', p.destacado||0, p.id]);
            await client.query('DELETE FROM variantes WHERE "productoId"=$1', [p.id]);
        } else {
            await client.query('INSERT INTO productos (id,nombre,precio,"precioMayor",descripcion,"categoriaId",subcategoria,destacado) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                [p.id, p.nombre, p.precio, p.precioMayor||0, p.descripcion||'', p.categoriaId ? parseInt(p.categoriaId) : null, p.subcategoria||'', p.destacado||0]);
        }
        if (p.variantes?.length) {
            const nombresUnicos = new Map();
            for (const v of p.variantes) {
                if (!v.nombre?.trim()) continue;
                nombresUnicos.set(v.nombre.trim().toLowerCase(), v);
            }
            for (const v of nombresUnicos.values()) {
                await client.query('INSERT INTO variantes ("productoId", nombre, stock, foto) VALUES ($1,$2,$3,$4)', [p.id, v.nombre.trim(), v.stock||0, v.foto||'']);
            }
        }
        await client.query('COMMIT');
        await logActividad('Admin', 'GUARDAR_PRODUCTO', `Producto: ${p.nombre}`, req);
        res.json({ success: true });
    } catch(e) {
        await client.query('ROLLBACK').catch(()=>{});
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

app.post('/eliminar-producto', async (req, res) => {
    await pool.query('DELETE FROM productos WHERE id=$1', [req.body.id]);
    await logActividad('Admin', 'ELIMINAR_PRODUCTO', `ID: ${req.body.id}`, req);
    res.json({ success: true });
});

app.post('/reordenar-productos', async (req, res) => {
    try {
        const { lista } = req.body;
        if (lista && lista.length) {
            for (const item of lista) {
                await pool.query('UPDATE productos SET orden = $1 WHERE id = $2', [item.orden, item.id]);
            }
        }
        res.json({ success: true });
    } catch(e) { 
        console.error('Error:', e.message);
        res.status(500).json({ error: e.message }); 
    }
});
app.post('/verificar-stock', async (req, res) => {
    const v = (await pool.query('SELECT stock FROM variantes WHERE "productoId"=$1 AND nombre=$2', [req.body.productoId, req.body.varianteNombre])).rows[0];
    if (!v) return res.status(404).json({ error: 'No encontrada' });
    res.json({ stock: v.stock });
});
app.post('/stock-bajo', async (req, res) => {
    const vars = (await pool.query('SELECT v.*, p.nombre as "productoNombre" FROM variantes v JOIN productos p ON v."productoId"=p.id WHERE v.stock <= $1', [req.body.minimo||5])).rows;
    res.json({ stockBajo: vars });
});
app.post('/subir-imagen', upload.single('foto'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No imagen' });
    const r = await cloudinary.uploader.upload(req.file.path, { folder: 'casa-elegida' });
    fs.unlinkSync(req.file.path);
    res.json({ url: r.secure_url });
});
app.post('/subir-logo', adminMiddleware('config'), upload.single('logo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No imagen' });
    const r = await cloudinary.uploader.upload(req.file.path, { folder: 'casa-elegida' });
    fs.unlinkSync(req.file.path);
    await setConfig('logo', r.secure_url);
    await logActividad('Admin', 'SUBIR_LOGO', 'Logo actualizado', req);
    res.json({ success: true });
});
app.post('/eliminar-logo', adminMiddleware('config'), async (req, res) => { await setConfig('logo', ''); res.json({ success: true }); });

app.post('/listar-categorias', async (req, res) => {
    const cats = (await pool.query('SELECT * FROM categorias')).rows;
    res.json({ lista: cats.map(c => ({ ...c, subcategorias: JSON.parse(c.subcategorias||'[]') })) });
});

app.post('/guardar-categoria', async (req, res) => {
    const { id, nombre, subcategorias } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    const existe = (await pool.query('SELECT id FROM categorias WHERE id=$1', [id])).rows[0];
    if (existe) {
        await pool.query('UPDATE categorias SET nombre=$1,subcategorias=$2 WHERE id=$3', [nombre.trim(), JSON.stringify(subcategorias||[]), id]);
    } else {
        const nuevoId = id || Math.floor(Date.now() / 1000);
        await pool.query('INSERT INTO categorias (id,nombre,subcategorias) VALUES ($1,$2,$3)', [nuevoId, nombre.trim(), JSON.stringify(subcategorias||[])]);
    }
    await logActividad('Admin', 'GUARDAR_CATEGORIA', `Categoría: ${nombre}`, req);
    res.json({ success: true });
});

app.post('/eliminar-categoria', async (req, res) => { await pool.query('DELETE FROM categorias WHERE id=$1', [req.body.id]); res.json({ success: true }); });
app.post('/listar-metodos-envio', async (req, res) => {
    const metodos = (await pool.query('SELECT nombre FROM metodos_envio')).rows;
    res.json({ lista: metodos.map(m => m.nombre) });
});
app.post('/guardar-metodos-envio', async (req, res) => {
    await pool.query('DELETE FROM metodos_envio');
    for (const m of (req.body.lista||[])) await pool.query('INSERT INTO metodos_envio (nombre) VALUES ($1)', [m]);
    res.json({ success: true });
});

app.post('/get-config', async (req, res) => {
    try {
        const config = await getConfig();
        res.json(config);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/save-config', adminMiddleware('config'), async (req, res) => {
    ['empresa','horarios','redes','pagos','banners','anuncios'].forEach(async k => { 
        if(req.body[k]) await setConfig(k, req.body[k]); 
    });
    await logActividad('Admin', 'GUARDAR_CONFIG', 'Configuración actualizada', req);
    res.json({ success: true });
});
app.post('/save-tienda-config', adminMiddleware('config'), async (req, res) => { if(req.body.tienda) await setConfig('tienda', req.body.tienda); res.json({ success: true }); });
app.post('/save-mayorista-config', adminMiddleware('config'), async (req, res) => { await setConfig('mayorista', req.body); await logActividad('Admin', 'GUARDAR_MAYORISTA', JSON.stringify(req.body), req); res.json({ success: true }); });
app.post('/save-diseno-config', adminMiddleware('config'), async (req, res) => { if(req.body.diseno) await setConfig('diseno', req.body.diseno); res.json({ success: true }); });
app.post('/save-home-config', adminMiddleware('config'), async (req, res) => { if(req.body.heroConfig) await setConfig('heroConfig', req.body.heroConfig); res.json({ success: true }); });
app.post('/save-plantilla', adminMiddleware('web'), async (req, res) => { await setConfig('plantilla', req.body.plantilla); res.json({ success: true }); });
app.post('/save-icono', adminMiddleware('web'), async (req, res) => { await setConfig('icono', req.body.icono); res.json({ success: true }); });

app.post('/confirmar-venta', adminMiddleware('ventas'), async (req, res) => {
    try {
        const { carrito, pago, logistica, cliente, metodoEnvio, canalVenta } = req.body;
        if (!carrito?.length) return res.status(400).json({ error: 'Carrito vacío' });
        if (logistica === 'envio' && !metodoEnvio) return res.status(400).json({ error: 'Seleccioná un medio de envío' });
        for (let it of carrito) {
            if (it.esManual) continue;
            const stockActual = (await pool.query('SELECT stock FROM variantes WHERE "productoId"=$1 AND nombre=$2', [it.pId, it.vNom])).rows[0];
            if (!stockActual || stockActual.stock < it.cant) return res.status(400).json({ error: `Stock insuficiente: ${it.pNom} - ${it.vNom}. Disponible: ${stockActual?.stock || 0}` });
        }
        for (let it of carrito) { if(it.esManual) continue; await pool.query('UPDATE variantes SET stock=stock-$1 WHERE "productoId"=$2 AND nombre=$3', [it.cant, it.pId, it.vNom]); }

        const totalFinal = pago.total || 0;
        const esMayorista = carrito.some(it => it.precioOriginal && it.precio < it.precioOriginal) ? 1 : 0;
        const vendedor = req.admin?.nombre || 'Admin';

        if (logistica === 'envio') {
            const pedidoId = 'PED-' + Date.now();
            const canalFinal = canalVenta === 'whatsapp' ? 'whatsapp' : 'mostrador';
            await pool.query(
                `INSERT INTO pedidos (id, fecha, "fechaTimestamp", items, total, cliente, "tipoEntrega", "metodoEnvio", "esMayorista", estado, origen, "stockDescontado")
                 VALUES ($1, TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY HH24:MI:SS'), $2, $3, $4, $5, 'envio', $6, $7, 'pendiente', $8, 1)`,
                [pedidoId, Date.now(), JSON.stringify(carrito), totalFinal, JSON.stringify(cliente||{}), metodoEnvio, esMayorista, canalFinal]
            );
            await crearNotificacion('pedido', '📦 Pedido para armar', `${pedidoId} (${canalFinal})`);
            await logActividad(vendedor, 'PEDIDO_MOSTRADOR', `Pedido ${pedidoId} — stock reservado, sin abonar aún`, req);
            return res.json({ success: true, pedidoId, ventaId: null });
        }

        const id = 'FAC-' + Date.now();
        const montoEfectivo = pago.metodo === 'efectivo' ? totalFinal : (pago.metodo === 'mixto' ? (pago.efectivo||0) : 0);
        const montoTransferencia = pago.metodo === 'transferencia' ? totalFinal : (pago.metodo === 'mixto' ? (pago.transferencia||0) : 0);
        await pool.query("INSERT INTO ventas (id,fecha,\"fechaTimestamp\",items,total,\"metodoPago\",logistica,cliente,estado,origen,\"montoEfectivo\",\"montoTransferencia\",\"esMayorista\",vendedor) VALUES ($1,TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY HH24:MI:SS'),$2,$3,$4,$5,$6,$7,'completada','admin',$8,$9,$10,$11)",
            [id, Date.now(), JSON.stringify(carrito), totalFinal, pago.metodo, logistica, JSON.stringify(cliente||{nombre:'Mostrador'}), montoEfectivo, montoTransferencia, esMayorista, vendedor]);
        await crearNotificacion('venta', '💰 Venta', `${id}`);
        await logActividad(vendedor, 'VENTA', `Venta ${id}`, req);
        res.json({ success: true, ventaId: id, pedidoId: null });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/listar-ventas', async (req, res) => {
    const ventas = (await pool.query('SELECT * FROM ventas ORDER BY "fechaTimestamp" DESC')).rows;
    res.json({ lista: ventas.map(v => ({ ...v, items: JSON.parse(v.items||'[]'), cliente: JSON.parse(v.cliente||'{}'), pago: { total: v.total, metodo: v["metodoPago"] } })) });
});

app.post('/corte-caja', async (req, res) => {
    const v = (await pool.query("SELECT COALESCE(SUM(total),0) as total, COUNT(*) as cantidad FROM ventas WHERE fecha LIKE TO_CHAR(CURRENT_DATE, 'DD/MM/YYYY') || '%'")).rows[0];
    res.json({ total: v.total, cantidad: v.cantidad });
});

app.post('/tienda/listar-productos', async (req, res) => {
    const [c, prodsResult, variantesResult, catsResult, metodosResult] = await Promise.all([
        getConfig(),
        pool.query('SELECT * FROM productos ORDER BY id DESC'),
        pool.query('SELECT * FROM variantes ORDER BY "productoId", id ASC'),
        pool.query('SELECT * FROM categorias'),
        pool.query('SELECT nombre FROM metodos_envio')
    ]);
    c.banners = c.banners || [];
    c.anuncios = c.anuncios || [];
    const prods = prodsResult.rows;
    const varMap = {};
    variantesResult.rows.forEach(v => {
        if (!varMap[v.productoId]) varMap[v.productoId] = [];
        varMap[v.productoId].push(v);
    });
    prods.forEach(p => { p.variantes = varMap[p.id] || []; });
    res.json({
        productos: prods,
        categorias: catsResult.rows.map(x => ({ ...x, subcategorias: JSON.parse(x.subcategorias||'[]') })),
        metodosEnvio: metodosResult.rows.map(m => m.nombre),
        configuracion: c
    });
});

app.post('/tienda/crear-pedido', authMiddleware, async (req, res) => {
    try {
        const { carrito, cliente, total, tipoEntrega, metodoEnvio } = req.body;
        if (!carrito?.length) return res.status(400).json({ error: 'Carrito vacío' });
        const u = (await pool.query('SELECT * FROM usuarios WHERE id=$1', [req.usuario.id])).rows[0];
        cliente.nombre = u.nombre; cliente.apellido = u.apellido; cliente.email = u.email; cliente.dni = u.dni||'';
        for (let it of carrito) {
            if (it.esManual) continue;
            const stockActual = (await pool.query('SELECT stock FROM variantes WHERE "productoId"=$1 AND nombre=$2', [it.pId, it.vNom])).rows[0];
            if (!stockActual || stockActual.stock < it.cant) return res.status(400).json({ error: `Stock insuficiente: ${it.pNom} - ${it.vNom}. Disponible: ${stockActual?.stock || 0}` });
        }
        for (let it of carrito) { if(it.esManual) continue; await pool.query('UPDATE variantes SET stock=stock-$1 WHERE "productoId"=$2 AND nombre=$3', [it.cant, it.pId, it.vNom]); }
        const id = 'PED-' + Date.now();
        await pool.query("INSERT INTO pedidos (id,fecha,\"fechaTimestamp\",items,total,cliente,\"tipoEntrega\",\"metodoEnvio\",estado,origen,\"usuarioId\") VALUES ($1,TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY HH24:MI:SS'),$2,$3,$4,$5,$6,$7,'pendiente','tienda',$8)",
            [id, Date.now(), JSON.stringify(carrito), total, JSON.stringify(cliente), tipoEntrega, metodoEnvio, u.id]);
        await crearNotificacion('pedido', '🛍️ Nuevo pedido', `#${id}`);
        await logActividad(cliente.nombre, 'PEDIDO_WEB', `Pedido #${id}`, req);
        res.json({ success: true, pedidoId: id });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/tienda/subir-comprobante', authMiddleware, upload.single('comprobante'), async (req, res) => {
    try {
        const { pedidoId } = req.body;
        if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen. Formatos permitidos: PNG o JPG.' });
        const p = (await pool.query('SELECT * FROM pedidos WHERE id=$1 AND "usuarioId"=$2', [pedidoId, req.usuario.id])).rows[0];
        if (!p) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Pedido no encontrado' }); }
        const r = await cloudinary.uploader.upload(req.file.path, { folder: 'casa-elegida/comprobantes' });
        fs.unlinkSync(req.file.path);
        const fechaLocal = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        await pool.query('UPDATE pedidos SET comprobante=$1, "comprobanteFecha"=$2 WHERE id=$3', [r.secure_url, fechaLocal, pedidoId]);
        await crearNotificacion('pedido', '📎 Comprobante recibido', `Pedido ${pedidoId}`);
        await logActividad(p.cliente ? (JSON.parse(p.cliente).nombre||'Cliente') : 'Cliente', 'COMPROBANTE_SUBIDO', `Pedido ${pedidoId}`, req);
        res.json({ success: true, url: r.secure_url });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/tienda/listar-pedidos', async (req, res) => {
    const pedidos = (await pool.query('SELECT * FROM pedidos ORDER BY "fechaTimestamp" DESC')).rows;
    res.json({ lista: pedidos.map(p => ({ ...p, items: JSON.parse(p.items||'[]'), cliente: JSON.parse(p.cliente||'{}') })) });
});

app.post('/tienda/confirmar-pedido', async (req, res) => {
    try {
        const p = (await pool.query('SELECT * FROM pedidos WHERE id=$1', [req.body.pedidoId])).rows[0];
        if (!p) return res.status(400).json({ error: 'Pedido no encontrado' });
        if (p.estado !== 'pendiente') return res.status(400).json({ error: 'El pedido ya está ' + p.estado });
        
        const esRetiroLocal = p["tipoEntrega"] === 'local';
        const pin = esRetiroLocal ? generarPIN() : null;
        const vid = 'FAC-' + Date.now();
        const itemsArr = JSON.parse(p.items || '[]');
        const esMayorista = itemsArr.some(it => it.precioOriginal && it.precio < it.precioOriginal) ? 1 : 0;
        await pool.query("INSERT INTO ventas (id,fecha,\"fechaTimestamp\",items,total,\"metodoPago\",logistica,cliente,estado,origen,\"pedidoId\",\"esMayorista\",vendedor) VALUES ($1,TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY HH24:MI:SS'),$2,$3,$4,'pedido_online',$5,$6,'completada','tienda',$7,$8,'Tienda Web')",
            [vid, Date.now(), p.items, p.total, p["tipoEntrega"]==='envio'?'envio':'local', p.cliente, p.id, esMayorista]);
        await pool.query('UPDATE pedidos SET estado=$1,pin=$2,"ventaId"=$3 WHERE id=$4', ['confirmado', pin || null, vid, p.id]);
        await logActividad('Admin', 'CONFIRMAR_PEDIDO', `Pedido ${p.id} confirmado`, req);
        const cliente = JSON.parse(p.cliente||'{}');
        if (cliente.email) {
            const mensajePin = esRetiroLocal ? `<p>Tu PIN de retiro: <strong>${pin}</strong></p>` : '';
            await enviarEmail(cliente.email, `Pedido #${p.id} confirmado`, `<h1>Casa Elegida</h1><h2>¡Pedido confirmado!</h2>${mensajePin}<p>Total: ${fmt.format(p.total)}</p>`);
        }
        res.json({ success: true, ventaId: vid, pin: pin || undefined });
    } catch(e) { 
        console.error('Error confirmar-pedido:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/tienda/cancelar-pedido', authMiddleware, async (req, res) => {
    const p = (await pool.query('SELECT * FROM pedidos WHERE id=$1 AND "usuarioId"=$2 AND estado=$3', [req.body.pedidoId, req.usuario.id, 'pendiente'])).rows[0];
    if (!p) return res.status(400).json({ error: 'No se puede cancelar' });
    JSON.parse(p.items||'[]').forEach(async it => { if(!it.esManual) await pool.query('UPDATE variantes SET stock=stock+$1 WHERE "productoId"=$2 AND nombre=$3', [it.cant, it.pId, it.vNom]); });
    await pool.query("UPDATE pedidos SET estado='cancelado' WHERE id=$1", [p.id]);
    await logActividad('Sistema', 'CANCELAR_PEDIDO', `Pedido ${p.id} cancelado`, req);
    res.json({ success: true });
});

app.post('/tienda/marcar-abonado', adminMiddleware('pedidos'), async (req, res) => {
    try {
        const cajaabierta = (await pool.query("SELECT id FROM turnos_caja WHERE estado='abierto' LIMIT 1")).rows[0];
        if (!cajaabierta) return res.status(400).json({ error: 'Debe abrir caja antes de abonar un pedido web' });
        const p = (await pool.query('SELECT * FROM pedidos WHERE id=$1', [req.body.pedidoId])).rows[0];
        if (!p) return res.status(404).json({ error: 'Pedido no encontrado' });
        const esRetiroLocal = p.tipoEntrega === 'local';
        const pin = esRetiroLocal ? generarPIN() : null;

        const itemsArr = JSON.parse(p.items || '[]');
        const esMayorista = itemsArr.some(it => it.precioOriginal && it.precio < it.precioOriginal) ? 1 : 0;

        let vendedorLabel = 'Tienda Web';
        if (p.origen === 'mostrador') vendedorLabel = req.admin?.nombre || 'Mostrador';
        else if (p.origen === 'whatsapp') vendedorLabel = (req.admin?.nombre || 'Admin') + ' (WhatsApp)';

        const ventaExistente = (await pool.query('SELECT id FROM ventas WHERE "pedidoId"=$1', [p.id])).rows[0];
        let vid = ventaExistente?.id;
        if (!ventaExistente) {
            vid = 'FAC-' + Date.now();
            await pool.query("INSERT INTO ventas (id,fecha,\"fechaTimestamp\",items,total,\"metodoPago\",logistica,cliente,estado,origen,\"pedidoId\",\"esMayorista\",vendedor) VALUES ($1,TO_CHAR(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires','DD/MM/YYYY HH24:MI:SS'),$2,$3,$4,'pedido_online',$5,$6,'completada','tienda',$7,$8,$9)",
                [vid, Date.now(), p.items, p.total, p.tipoEntrega==='envio'?'envio':'local', p.cliente, p.id, esMayorista, vendedorLabel]);
        }

        await pool.query("UPDATE pedidos SET estado='abonado', pin=$1, \"ventaId\"=$2, \"timestampAbono\"=$3 WHERE id=$4", [pin, vid, Date.now(), req.body.pedidoId]);
        await logActividad(vendedorLabel, 'PEDIDO_ABONADO', `Pedido ${req.body.pedidoId} abonado`, req);
        res.json({ success: true, pin });
        if (pin) {
            try {
                const cliente = JSON.parse(p.cliente || '{}');
                if (cliente.email) {
                    enviarEmail(cliente.email, `PIN de Retiro - Pedido ${p.id}`,
                        `<h1>Casa Elegida</h1><h2>Tu pedido fue abonado ✅</h2><p>Tu PIN de retiro es:</p><h1 style="letter-spacing:8px;color:#3D312A">${pin}</h1><p>Presentá este código al retirar tu pedido en el local.</p>`
                    ).catch(e => console.error('Email error:', e));
                }
            } catch(emailErr) { console.error('Error email:', emailErr); }
        }
    } catch(e) {
        console.error('Error marcar-abonado:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/tienda/marcar-enviado', async (req, res) => {
    await pool.query("UPDATE pedidos SET estado='enviado' WHERE id=$1", [req.body.pedidoId]);
    await logActividad('Admin', 'PEDIDO_ENVIADO', `Pedido ${req.body.pedidoId} enviado`, req);
    res.json({ success: true });
});

app.post('/tienda/marcar-entregado', async (req, res) => { await pool.query("UPDATE pedidos SET estado='entregado' WHERE id=$1", [req.body.pedidoId]); res.json({ success: true }); });
app.post('/tienda/marcar-armado', async (req, res) => {
    await pool.query("UPDATE pedidos SET estado='armado' WHERE id=$1", [req.body.pedidoId]);
    await logActividad('Admin', 'PEDIDO_ARMADO', `Pedido ${req.body.pedidoId} armado`, req);
    res.json({ success: true });
});

app.post('/tienda/cancelar-pedido-admin', async (req, res) => {
    const p = (await pool.query('SELECT * FROM pedidos WHERE id=$1', [req.body.pedidoId])).rows[0];
    if (!p) return res.status(400).json({ error: 'No encontrado' });
    JSON.parse(p.items||'[]').forEach(async it => { if(!it.esManual) await pool.query('UPDATE variantes SET stock=stock+$1 WHERE "productoId"=$2 AND nombre=$3', [it.cant, it.pId, it.vNom]); });
    await pool.query("UPDATE pedidos SET estado='cancelado' WHERE id=$1", [p.id]);
    res.json({ success: true });
});

app.post('/tienda/retirar-pedido', async (req, res) => {
    const p = (await pool.query('SELECT * FROM pedidos WHERE id=$1 AND pin=$2', [req.body.pedidoId, req.body.pin])).rows[0];
    if (!p) return res.status(400).json({ error: 'PIN incorrecto' });
    await pool.query("UPDATE pedidos SET estado='entregado' WHERE id=$1", [p.id]);
    await logActividad('Admin', 'RETIRO_PEDIDO', `Pedido ${req.body.pedidoId} retirado`, req);
    res.json({ success: true });
});

app.post('/tienda/verificar-pin', async (req, res) => {
    const p = (await pool.query("SELECT * FROM pedidos WHERE pin=$1 AND estado IN ('confirmado','abonado','armado')", [req.body.pin])).rows[0];
    if (!p) return res.status(400).json({ error: 'PIN no encontrado' });
    res.json({ success: true, pedido: { ...p, cliente: JSON.parse(p.cliente||'{}'), items: JSON.parse(p.items||'[]') } });
});

app.post('/dashboard/stats', async (req, res) => {
    const v = (await pool.query("SELECT COUNT(*) as c, COALESCE(SUM(total),0) as t FROM ventas WHERE fecha LIKE TO_CHAR(CURRENT_DATE, 'DD/MM/YYYY') || '%'")).rows[0];
    res.json({ ventasHoy: v.c, totalHoy: v.t });
});

app.post('/admin/estadisticas-avanzadas', adminMiddleware('dashboard'), async (req, res) => {
    const mes = new Date().toLocaleDateString('es-AR').substring(3);
    const ventasMes = (await pool.query("SELECT * FROM ventas WHERE fecha LIKE $1 AND estado != 'cancelada'", [`%${mes}%`])).rows;
    let efAdmin = 0, trAdmin = 0, efWeb = 0, trWeb = 0;
    ventasMes.forEach(v => {
        if (v.origen === 'admin') {
            if (v["metodoPago"] === 'efectivo') efAdmin += v.total;
            if (v["metodoPago"] === 'transferencia') trAdmin += v.total;
        }
        if (v.origen === 'tienda') trWeb += v.total;
    });
    res.json({
        ventasHoy: 0, ventasMes: 0, totalClientes: (await pool.query('SELECT COUNT(*) as c FROM usuarios')).rows[0].c,
        totalProductos: (await pool.query('SELECT COUNT(*) as c FROM productos')).rows[0].c,
        pedidosPendientes: (await pool.query("SELECT COUNT(*) as c FROM pedidos WHERE estado IN ('pendiente','confirmado','abonado')")).rows[0].c,
        productosAgotados: 0,
        rendimientoMensual: { efAdmin, trAdmin, efWeb, trWeb, total: efAdmin+trAdmin+efWeb+trWeb }
    });
});

app.post('/admin/buscar-clientes', adminMiddleware(), async (req, res) => {
    const q = `%${req.body.query||''}%`;
    const clientes = (await pool.query('SELECT id, nombre, apellido, email, telefono, dni FROM usuarios WHERE nombre ILIKE $1 OR apellido ILIKE $1 OR email ILIKE $1 OR dni ILIKE $1 LIMIT 20', [q])).rows;
    res.json({ lista: clientes });
});

app.post('/admin/listar-clientes', adminMiddleware(), async (req, res) => {
    try {
        const clientes = (await pool.query('SELECT id, nombre, apellido, email, telefono, dni, provincia, localidad FROM usuarios WHERE rol = $1 ORDER BY "fechaRegistro" DESC LIMIT 200', ['cliente'])).rows;
        res.json({ lista: clientes });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/eliminar-cliente', adminMiddleware(), async (req, res) => {
    try {
        const { userId, adminPassword } = req.body;
        // Verificar contraseña del admin
        const adminPerfil = (await pool.query("SELECT * FROM perfiles WHERE usuario = $1", [req.admin.usuario])).rows[0];
        if (!(await bcrypt.compare(adminPassword, adminPerfil.password))) return res.status(401).json({ error: 'Contraseña incorrecta' });
        
        const cliente = (await pool.query('SELECT * FROM usuarios WHERE id = $1', [userId])).rows[0];
        if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
        
        // Eliminar sus pedidos
        await pool.query('DELETE FROM pedidos WHERE "usuarioId" = $1', [userId]);
        // Eliminar sus ventas (local)
        await pool.query("DELETE FROM ventas WHERE cliente::text LIKE $1", [`%${userId}%`]);
        // Eliminar el usuario
        await pool.query('DELETE FROM usuarios WHERE id = $1', [userId]);
        
        await logActividad(req.admin.nombre, 'ELIMINAR_CLIENTE', `Cliente eliminado: ${cliente.nombre} ${cliente.apellido} (${cliente.email})`, req);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/historial-cliente', adminMiddleware(), async (req, res) => {
    try {
        const { userId } = req.body;
        const ventas = (await pool.query('SELECT id, fecha, total FROM ventas WHERE cliente::text LIKE $1 ORDER BY "fechaTimestamp" DESC LIMIT 50', [`%${userId}%`])).rows;
        const pedidos = (await pool.query('SELECT id, fecha, total, estado FROM pedidos WHERE "usuarioId" = $1 ORDER BY "fechaTimestamp" DESC LIMIT 50', [userId])).rows;
        res.json({ ventas, pedidos });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/cancelar-venta', adminMiddleware('ventas'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { ventaId } = req.body;
        const v = (await client.query('SELECT * FROM ventas WHERE id=$1', [ventaId])).rows[0];
        if (!v) { client.release(); return res.status(404).json({ error: 'Venta no encontrada' }); }
        if (v.estado === 'cancelada') { client.release(); return res.status(400).json({ error: 'Esta venta ya está cancelada' }); }

        await client.query('BEGIN');

        const items = JSON.parse(v.items || '[]');
        for (const it of items) {
            if (it.esManual) continue;
            await client.query('UPDATE variantes SET stock=stock+$1 WHERE "productoId"=$2 AND nombre=$3', [it.cant, it.pId, it.vNom]);
        }

        const fechaLocal = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        await client.query('UPDATE ventas SET estado=$1, "canceladaPor"=$2, "fechaCancelacion"=$3 WHERE id=$4',
            ['cancelada', req.admin.nombre, fechaLocal, ventaId]);

        if (v.pedidoId) {
            const p = (await client.query('SELECT estado FROM pedidos WHERE id=$1', [v.pedidoId])).rows[0];
            if (p && p.estado !== 'cancelado' && p.estado !== 'entregado') {
                await client.query("UPDATE pedidos SET estado='cancelado' WHERE id=$1", [v.pedidoId]);
            }
        }

        await client.query('COMMIT');
        await logActividad(req.admin.nombre, 'CANCELAR_VENTA', `Venta ${ventaId} cancelada — stock restaurado`, req);
        res.json({ success: true });
    } catch(e) {
        await client.query('ROLLBACK').catch(()=>{});
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

app.post('/admin/exportar-ventas', adminMiddleware(), async (req, res) => {
    let csv = '\uFEFFFecha;ID;Cliente;Total;Pago;Origen\n';
    const ventas = (await pool.query('SELECT * FROM ventas ORDER BY "fechaTimestamp" DESC')).rows;
    ventas.forEach(v => { const c = JSON.parse(v.cliente||'{}'); csv += `"${v.fecha}";"${v.id}";"${c.nombre||'Mostrador'}";"${v.total}";"${v["metodoPago"]}";"${v.origen}"\n`; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=ventas.csv');
    res.send(csv);
});

app.post('/admin/apertura-caja-profesional', adminMiddleware('ventas'), async (req, res) => {
    try {
        const { montoEfectivo, montoTransferencia } = req.body;
        const hoy = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const existe = await pool.query('SELECT * FROM caja_profesional WHERE fecha = $1', [hoy]);
        if (existe.rows.length > 0) return res.status(400).json({ error: 'La caja ya fue abierta hoy' });
        await pool.query(`INSERT INTO caja_profesional (fecha, "aperturaTimestamp", "abiertaPor", "montoInicialEfectivo", "montoInicialTransferencia", estado) VALUES ($1,$2,$3,$4,$5,'abierta')`,
            [hoy, Date.now(), req.admin.nombre, parseFloat(montoEfectivo)||0, parseFloat(montoTransferencia)||0]);
        await logActividad(req.admin.nombre, 'APERTURA_CAJA', `Ef: ${fmt.format(montoEfectivo||0)} | Transf: ${fmt.format(montoTransferencia||0)}`, req);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/cierre-caja-profesional', adminMiddleware('ventas'), async (req, res) => {
    try {
        const { efectivoEntregado, transferenciaEntregada } = req.body;
        const hoy = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const caja = (await pool.query('SELECT * FROM caja_profesional WHERE fecha = $1 AND estado = \'abierta\'', [hoy])).rows[0];
        if (!caja) return res.status(400).json({ error: 'No hay caja abierta hoy' });
        
        const ventasAdmin = (await pool.query('SELECT * FROM ventas WHERE fecha LIKE $1', [`%${hoy.split(' ')[0]}%`])).rows;
        let ventasEfectivo = 0, ventasTransferencia = 0, ventasWebTransferencia = 0;
        ventasAdmin.forEach(v => {
            if (v.origen === 'admin') {
                if (v.metodoPago === 'efectivo') ventasEfectivo += v.total;
                if (v.metodoPago === 'transferencia') ventasTransferencia += v.total;
            }
            if (v.origen === 'tienda') ventasWebTransferencia += v.total;
        });
        
        const inicialEf = parseFloat(caja.montoInicialEfectivo) || 0;
        const inicialTr = parseFloat(caja.montoInicialTransferencia) || 0;
        
        const totalEsperadoEfectivo = inicialEf + ventasEfectivo;
        const diferenciaEfectivo = (parseFloat(efectivoEntregado)||0) - totalEsperadoEfectivo;
        const totalEsperadoTransferencia = inicialTr + ventasTransferencia + ventasWebTransferencia;
        const diferenciaTransferencia = (parseFloat(transferenciaEntregada)||0) - totalEsperadoTransferencia;
        
        await pool.query(`UPDATE caja_profesional SET estado='cerrada', "cerradaPor"=$1, "cierreTimestamp"=$2,
            "efectivoEntregado"=$3, "transferenciaEntregada"=$4, "ventasEfectivo"=$5, "ventasTransferencia"=$6,
            "ventasWebTransferencia"=$7, "totalEsperadoEfectivo"=$8, "totalEsperadoTransferencia"=$9,
            "diferenciaEfectivo"=$10, "diferenciaTransferencia"=$11, "cantidadVentas"=$12 WHERE fecha=$13 AND estado='abierta'`,
            [req.admin.nombre, Date.now(), parseFloat(efectivoEntregado)||0, parseFloat(transferenciaEntregada)||0, ventasEfectivo, ventasTransferencia,
             ventasWebTransferencia, totalEsperadoEfectivo, totalEsperadoTransferencia, diferenciaEfectivo, diferenciaTransferencia,
             ventasAdmin.length, hoy]);
             
        await logActividad(req.admin.nombre, 'CIERRE_CAJA', `Dif Ef: ${fmt.format(diferenciaEfectivo)} | Dif Transf: ${fmt.format(diferenciaTransferencia)}`, req);
        res.json({ success: true, resumen: { ventasEfectivo, ventasTransferencia, ventasWebTransferencia, totalEsperadoEfectivo, totalEsperadoTransferencia, diferenciaEfectivo, diferenciaTransferencia, cantidadVentas: ventasAdmin.length, montoInicialEfectivo: inicialEf, montoInicialTransferencia: inicialTr } });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/estado-caja-profesional', adminMiddleware('ventas'), async (req, res) => {
    try {
        const hoy = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const caja = (await pool.query('SELECT * FROM caja_profesional WHERE fecha = $1 AND estado = \'abierta\'', [hoy])).rows[0];
        if (!caja) return res.json({ abierta: false });
        
        const ventasAdmin = (await pool.query('SELECT * FROM ventas WHERE fecha LIKE $1', [`%${hoy.split(' ')[0]}%`])).rows;
        let ventasEfectivo = 0, ventasTransferencia = 0, ventasWeb = 0;
        ventasAdmin.forEach(v => {
            if (v.origen === 'admin') {
                if (v.metodoPago === 'efectivo') ventasEfectivo += v.total;
                if (v.metodoPago === 'transferencia') ventasTransferencia += v.total;
            }
            if (v.origen === 'tienda') ventasWeb += v.total;
        });
        
        const inicialEf = parseFloat(caja.montoInicialEfectivo) || 0;
        const inicialTr = parseFloat(caja.montoInicialTransferencia) || 0;
        
        res.json({ 
            abierta: true, 
            abiertaPor: caja.abiertaPor, 
            montoInicialEfectivo: inicialEf, 
            montoInicialTransferencia: inicialTr, 
            ventasEfectivo, 
            ventasTransferencia, 
            ventasWeb, 
            totalEsperadoEfectivo: inicialEf + ventasEfectivo, 
            totalEsperadoTransferencia: inicialTr + ventasTransferencia + ventasWeb, 
            amountVentas: ventasAdmin.length 
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/historial-cajas', adminMiddleware('dashboard'), async (req, res) => {
    try {
        const { desde, hasta } = req.body;
        let query = "SELECT * FROM caja_profesional WHERE estado = 'cerrada'";
        let params = [];
        if (desde) { query += " AND fecha >= $" + (params.length+1); params.push(desde); }
        if (hasta) { query += " AND fecha <= $" + (params.length+1); params.push(hasta); }
        query += " ORDER BY fecha DESC LIMIT 100";
        const cajas = (await pool.query(query, params)).rows;
        res.json({ lista: cajas });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/estadisticas-vendedor', adminMiddleware('dashboard'), async (req, res) => {
    const logs = (await pool.query("SELECT admin, accion, COUNT(*) as c FROM logs_admin WHERE accion IN ('VENTA','CONFIRMAR_PEDIDO') GROUP BY admin, accion")).rows;
    const v = {};
    logs.forEach(l => { if(!v[l.admin]) v[l.admin]={nombre:l.admin,ventas:0,pedidos:0}; if(l.accion==='VENTA')v[l.admin].ventas+=l.c; else v[l.admin].pedidos+=l.c; });
    res.json({ lista: Object.values(v) });
});

app.post('/admin/dashboard/data', adminMiddleware('dashboard'), async (req, res) => {
    try {
        const { periodo = 'mes' } = req.body;
        let fechaInicio;
        const ahora = new Date();
        switch (periodo) {
            case 'hoy': fechaInicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()); break;
            case 'semana': fechaInicio = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000); break;
            case 'mes': fechaInicio = new Date(ahora.getFullYear(), ahora.getMonth(), 1); break;
            case 'anio': fechaInicio = new Date(ahora.getFullYear(), 0, 1); break;
            default: fechaInicio = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
        }
        const ventasQuery = await pool.query("SELECT * FROM ventas WHERE \"fechaTimestamp\" >= $1", [fechaInicio.getTime()]);
        const diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        const ventasPorDia = [0, 0, 0, 0, 0, 0, 0];
        const efectivoPorDia = [0, 0, 0, 0, 0, 0, 0];
        const transferenciaPorDia = [0, 0, 0, 0, 0, 0, 0];
        ventasQuery.rows.forEach(v => {
            const fecha = new Date(v.fechaTimestamp);
            const dia = fecha.getDay();
            ventasPorDia[dia] += v.total || 0;
            if (v.metodoPago === 'efectivo') efectivoPorDia[dia] += v.total || 0;
            if (v.metodoPago === 'transferencia') transferenciaPorDia[dia] += v.total || 0;
        });
        const productosCount = {};
        ventasQuery.rows.forEach(v => {
            const items = typeof v.items === 'string' ? JSON.parse(v.items) : (v.items || []);
            items.forEach(i => { const key = i.pNom || 'Desconocido'; productosCount[key] = (productosCount[key] || 0) + (i.cant || 1); });
        });
        const productosTop = Object.entries(productosCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const categoriasCount = {};
        const productos = await pool.query('SELECT id, nombre, "categoriaId" FROM productos');
        const categorias = await pool.query('SELECT id, nombre FROM categorias');
        ventasQuery.rows.forEach(v => {
            const items = typeof v.items === 'string' ? JSON.parse(v.items) : (v.items || []);
            items.forEach(i => {
                const prod = productos.rows.find(p => p.id == i.pId);
                if (prod) { const cat = categorias.rows.find(c => c.id == prod.categoriaId); const catNombre = cat ? cat.nombre : 'Sin categoría'; categoriasCount[catNombre] = (categoriasCount[catNombre] || 0) + (i.precio * i.cant || 0); }
            });
        });
        const categoriasTop = Object.entries(categoriasCount).sort((a, b) => b[1] - a[1]).slice(0, 7);
        res.json({
            ventasDia: { labels: diasSemana, valores: ventasPorDia },
            productosTop: { labels: productosTop.length ? productosTop.map(p => p[0]) : ['Sin datos'], valores: productosTop.length ? productosTop.map(p => p[1]) : [0] },
            metodosPago: { labels: diasSemana, efectivo: efectivoPorDia, transferencia: transferenciaPorDia },
            categorias: { labels: categoriasTop.length ? categoriasTop.map(c => c[0]) : ['Sin datos'], valores: categoriasTop.length ? categoriasTop.map(c => c[1]) : [0] }
        });
    } catch (error) { console.error('Error en dashboard data:', error); res.json({ ventasDia: { labels: ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'], valores: [0,0,0,0,0,0,0] }, productosTop: { labels: ['Sin datos'], valores: [1] }, metodosPago: { labels: ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'], efectivo: [0,0,0,0,0,0,0], transferencia: [0,0,0,0,0,0,0] }, categorias: { labels: ['Sin datos'], valores: [1] } }); }
});

app.post('/notificaciones', async (req, res) => { res.json({ lista: (await pool.query('SELECT * FROM notificaciones ORDER BY fecha DESC LIMIT 50')).rows }); });
app.post('/notificaciones/leer', async (req, res) => { await pool.query('UPDATE notificaciones SET leida=1 WHERE id=$1', [req.body.id]); res.json({ success: true }); });
app.post('/notificaciones/leer-todas', async (req, res) => { await pool.query('UPDATE notificaciones SET leida=1'); res.json({ success: true }); });

app.post('/logs/admin', async (req, res) => {
    const { filtro, desde, hasta } = req.body;
    let query = 'SELECT * FROM logs_admin'; let params = []; let conditions = [];
    if (filtro) { conditions.push('(admin ILIKE $1 OR accion ILIKE $1 OR detalles ILIKE $1)'); params.push(`%${filtro}%`); }
    if (desde) { conditions.push(`fecha::date >= $${params.length+1}`); params.push(desde); }
    if (hasta) { conditions.push(`fecha::date <= $${params.length+1}`); params.push(hasta); }
    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY fecha DESC LIMIT 500';
    const logs = (await pool.query(query, params)).rows;
    res.json({ lista: logs });
});

app.get('/api/mis-pedidos', authMiddleware, async (req, res) => {
    const pedidos = (await pool.query('SELECT * FROM pedidos WHERE "usuarioId"=$1 ORDER BY "fechaTimestamp" DESC', [req.usuario.id])).rows;
    res.json({ lista: pedidos.map(p => ({ ...p, items: JSON.parse(p.items||'[]'), cliente: JSON.parse(p.cliente||'{}') })) });
});

// ============================================
// SISTEMA DE BACKUP TOTAL
// ============================================
async function exportarTabla(nombreTabla) {
    const result = await pool.query(`SELECT * FROM ${nombreTabla}`);
    return result.rows;
}

app.post('/admin/backup/crear-total', adminMiddleware(), async (req, res) => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupId = `backup_total_${timestamp}`;
        const backupPath = path.join(BACKUP_DIR, backupId);
        fs.mkdirSync(backupPath, { recursive: true });
        console.log('📦 Iniciando backup total:', backupId);
        const datos = {
            metadata: { id: backupId, fecha: new Date().toISOString(), version: '2.0', tipo: 'total', sistema: 'Casa Elegida POS Master' },
            productos: await exportarTabla('productos'), variantes: await exportarTabla('variantes'),
            categorias: await exportarTabla('categorias'), ventas: await exportarTabla('ventas'),
            pedidos: await exportarTabla('pedidos'), usuarios: await exportarTabla('usuarios'),
            notificaciones: await exportarTabla('notificaciones'), configuracion: await exportarTabla('configuracion'),
            metodos_envio: await exportarTabla('metodos_envio'), logs_admin: await exportarTabla('logs_admin'),
            perfiles: await exportarTabla('perfiles'), caja_profesional: await exportarTabla('caja_profesional'),
        };
        const stats = { productos: datos.productos.length, ventas: datos.ventas.length, usuarios: datos.usuarios.length, pedidos: datos.pedidos.length, imagenes: 0, totalRegistros: 0 };
        Object.values(datos).forEach(val => { if (Array.isArray(val)) stats.totalRegistros += val.length; });
        datos.metadata.stats = stats;
        fs.writeFileSync(path.join(backupPath, 'data.json'), JSON.stringify(datos, null, 2));
        const imagenesDir = path.join(backupPath, 'imagenes'); fs.mkdirSync(imagenesDir, { recursive: true });
        const uploadsDir = path.join(__dirname, 'uploads');
        if (fs.existsSync(uploadsDir)) {
            const copiarRecursivo = (src, dest) => {
                const entries = fs.readdirSync(src, { withFileTypes: true });
                for (let entry of entries) {
                    const srcPath = path.join(src, entry.name), destPath = path.join(dest, entry.name);
                    if (entry.isDirectory()) { fs.mkdirSync(destPath, { recursive: true }); copiarRecursivo(srcPath, destPath); }
                    else { fs.copyFileSync(srcPath, destPath); stats.imagenes++; }
                }
            };
            copiarRecursivo(uploadsDir, imagenesDir);
        }
        datos.metadata.stats = stats;
        fs.writeFileSync(path.join(backupPath, 'data.json'), JSON.stringify(datos, null, 2));
        const zipFilename = `${backupId}.backup`, zipPath = path.join(BACKUP_DIR, zipFilename);
        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath), archive = archiver('zip', { zlib: { level: 9 } });
            output.on('close', resolve); archive.on('error', reject);
            archive.pipe(output); archive.directory(backupPath, backupId); archive.finalize();
        });
        fs.rmSync(backupPath, { recursive: true, force: true });
        const finalStats = fs.statSync(zipPath);
        await logActividad(req.admin.nombre, 'BACKUP_CREADO', `${stats.productos} prod, ${stats.ventas} ventas`, req);
        res.json({ success: true, id: backupId, filename: zipFilename, downloadUrl: `/admin/backup/descargar-archivo/${zipFilename}`, stats, tamano: (finalStats.size / 1024 / 1024).toFixed(2) });
    } catch (error) { console.error('❌ Error creando backup:', error); res.status(500).json({ error: 'Error al crear backup: ' + error.message }); }
});

app.post('/admin/backup/historial-total', adminMiddleware(), async (req, res) => {
    try {
        if (!fs.existsSync(BACKUP_DIR)) return res.json({ backups: [] });
        const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.backup') || f.endsWith('.zip')).map(f => {
            const filePath = path.join(BACKUP_DIR, f), stats = fs.statSync(filePath);
            return { id: f.replace('.backup', '').replace('.zip', ''), nombre: f, fecha: stats.mtime.toISOString(), tamano: (stats.size / 1024 / 1024).toFixed(2), automatico: f.includes('auto_'), stats: { productos: '?', ventas: '?' } };
        }).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
        res.json({ backups: files });
    } catch (error) { res.json({ backups: [] }); }
});

app.get('/admin/backup/descargar-archivo/:filename', adminMiddleware(), (req, res) => {
    const filePath = path.join(BACKUP_DIR, req.params.filename);
    if (fs.existsSync(filePath)) res.download(filePath);
    else res.status(404).json({ error: 'Archivo no encontrado' });
});

app.post('/admin/backup/descargar-total', adminMiddleware(), (req, res) => {
    const { id } = req.body;
    for (let ext of ['.backup', '.zip']) { const filePath = path.join(BACKUP_DIR, id + ext); if (fs.existsSync(filePath)) return res.json({ url: `/admin/backup/descargar-archivo/${id}${ext}` }); }
    res.status(404).json({ error: 'Backup no encontrado' });
});

app.post('/admin/backup/eliminar-total', adminMiddleware(), async (req, res) => {
    try {
        const { id } = req.body;
        for (let ext of ['.backup', '.zip']) { const filePath = path.join(BACKUP_DIR, id + ext); if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); await logActividad(req.admin.nombre, 'BACKUP_ELIMINADO', id, req); return res.json({ success: true }); } }
        res.status(404).json({ error: 'Backup no encontrado' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/admin/backup/restaurar-desde-archivo', adminMiddleware(), uploadBackup.single('backup'), async (req, res) => {
    const { password } = req.body;
    try {
        const adminPerfil = (await pool.query("SELECT * FROM perfiles WHERE usuario = $1", [req.admin.usuario])).rows[0];
        if (!(await bcrypt.compare(password, adminPerfil.password))) return res.status(403).json({ error: 'Contraseña incorrecta' });
        if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
        const tempDir = path.join(BACKUP_DIR, 'temp_restore_' + Date.now()); fs.mkdirSync(tempDir, { recursive: true });
        await fs.createReadStream(req.file.path).pipe(unzipper.Extract({ path: tempDir })).promise();
        let dataDir = tempDir;
        for (let file of fs.readdirSync(tempDir)) { const fullPath = path.join(tempDir, file); if (fs.statSync(fullPath).isDirectory()) { dataDir = fullPath; break; } }
        const dataPath = path.join(dataDir, 'data.json');
        if (!fs.existsSync(dataPath)) throw new Error('Archivo de datos no encontrado');
        const backup = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        await pool.query('DELETE FROM productos'); await pool.query('DELETE FROM variantes');
        await pool.query('DELETE FROM categorias'); await pool.query('DELETE FROM ventas');
        await pool.query('DELETE FROM pedidos'); await pool.query('DELETE FROM notificaciones');
        await pool.query('DELETE FROM configuracion');
        if (backup.productos) for (let p of backup.productos) await pool.query(`INSERT INTO productos (id, nombre, precio, "precioMayor", descripcion, "categoriaId", subcategoria, destacado) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [p.id, p.nombre, p.precio, p.precioMayor||0, p.descripcion||'', p.categoriaId, p.subcategoria||'', p.destacado||0]);
        if (backup.variantes) for (let v of backup.variantes) await pool.query('INSERT INTO variantes ("productoId", nombre, stock, foto) VALUES ($1,$2,$3,$4)', [v.productoId, v.nombre, v.stock||0, v.foto||'']);
        if (backup.categorias) for (let c of backup.categorias) await pool.query('INSERT INTO categorias (id, nombre, subcategorias) VALUES ($1,$2,$3)', [c.id, c.nombre, c.subcategorias||'[]']);
        if (backup.configuracion) for (let c of backup.configuracion) await pool.query('INSERT INTO configuracion (clave, valor) VALUES ($1,$2) ON CONFLICT (clave) DO UPDATE SET valor = $2', [c.clave, c.valor]);
        const imagenesBackup = path.join(dataDir, 'imagenes');
        if (fs.existsSync(imagenesBackup)) { const upDir = path.join(__dirname, 'uploads'); if (fs.existsSync(upDir)) fs.rmSync(upDir, { recursive: true, force: true }); fs.mkdirSync(upDir, { recursive: true }); const copiarRec = (src, dest) => { for (let e of fs.readdirSync(src, { withFileTypes: true })) { const sp = path.join(src, e.name), dp = path.join(dest, e.name); if (e.isDirectory()) { fs.mkdirSync(dp, { recursive: true }); copiarRec(sp, dp); } else fs.copyFileSync(sp, dp); } }; copiarRec(imagenesBackup, upDir); }
        fs.rmSync(tempDir, { recursive: true, force: true }); fs.unlinkSync(req.file.path);
        await logActividad(req.admin.nombre, 'RESTAURACION_SISTEMA', 'Sistema restaurado desde backup', req);
        res.json({ success: true, stats: { productos: backup.productos?.length||0, ventas: backup.ventas?.length||0, imagenes: backup.metadata?.stats?.imagenes||0 } });
    } catch (error) { console.error('Error restaurando:', error); res.status(500).json({ error: 'Error al restaurar: ' + error.message }); }
});

app.post('/admin/costos/guardar', adminMiddleware(), async (req, res) => {
    try {
        const { productoId, costoBase, costoEnvio, gastosAdicionales } = req.body;
        const gastos = gastosAdicionales || [];
        const costoGastos = gastos.reduce((s, g) => s + (parseFloat(g.monto) || 0), 0);
        const costoTotal = (parseFloat(costoBase)||0) + (parseFloat(costoEnvio)||0) + costoGastos;
        const id = 'COSTO-' + Date.now();
        await pool.query(
            'INSERT INTO costos_productos (id, "productoId", "costoBase", "costoEnvio", "gastosAdicionales", "costoTotal", "fechaTimestamp") VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [id, productoId, parseFloat(costoBase)||0, parseFloat(costoEnvio)||0, JSON.stringify(gastos), costoTotal, Date.now()]
        );
        await logActividad(req.admin.nombre, 'GUARDAR_COSTO', `Producto ${productoId}: costo $${costoTotal}`, req);
        res.json({ success: true, costoTotal });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/costos/obtener-todos', adminMiddleware(), async (req, res) => {
    try {
        const result = await pool.query(`SELECT DISTINCT ON ("productoId") * FROM costos_productos ORDER BY "productoId", "fechaTimestamp" DESC`);
        const costos = {};
        result.rows.forEach(c => { costos[c.productoId] = { ...c, gastosAdicionales: JSON.parse(c.gastosAdicionales || '[]') }; });
        res.json({ costos });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/ganancias/historial', adminMiddleware(), async (req, res) => {
    try {
        const { desde, hasta } = req.body;
        let query = "SELECT * FROM ventas WHERE estado != 'cancelada'";
        let params = [];
        if (desde) { 
            const desdeDate = desde.split('-').reverse().join('/');
            query += ` AND fecha >= $${params.length+1}`; 
            params.push(desdeDate); 
        }
        if (hasta) { 
            const hastaDate = hasta.split('-').reverse().join('/');
            query += ` AND fecha <= $${params.length+1} || '%'`; 
            params.push(hastaDate); 
        }
        query += ' ORDER BY "fechaTimestamp" DESC LIMIT 300';
        const ventas = (await pool.query(query, params)).rows;
        const resultados = [];
        let totalGanancia = 0, totalVentas = 0;
        for (const v of ventas) {
            const items = JSON.parse(v.items || '[]');
            let gananciaVenta = 0;
            const itemsDetalle = [];
            for (const item of items) {
                const costoResult = await pool.query(
                    'SELECT * FROM costos_productos WHERE "productoId"=$1 AND "fechaTimestamp" <= $2 ORDER BY "fechaTimestamp" DESC LIMIT 1',
                    [item.pId, v.fechaTimestamp]
                );
                const costo = costoResult.rows[0];
                const costoTotal = costo ? parseFloat(costo.costoTotal) : 0;
                const gananciaUnidad = (parseFloat(item.precio)||0) - costoTotal;
                const gananciaItem = gananciaUnidad * (item.cant||1);
                gananciaVenta += gananciaItem;
                itemsDetalle.push({ ...item, costoTotal, gananciaUnidad, gananciaTotal: gananciaItem });
            }
            totalGanancia += gananciaVenta;
            totalVentas += parseFloat(v.total)||0;
            resultados.push({ id: v.id, fecha: v.fecha, fechaTimestamp: v.fechaTimestamp, total: v.total, metodoPago: v.metodoPago, cliente: JSON.parse(v.cliente||'{}'), items: itemsDetalle, gananciaVenta });
        }
        res.json({ historial: resultados, totalGanancia, totalVentas, cantidadVentas: resultados.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/sincronizar-ventas-web', adminMiddleware(), async (req, res) => {
    try {
        const pedidos = (await pool.query(
            "SELECT * FROM pedidos WHERE estado IN ('abonado','armado','enviado','entregado') AND (\"ventaId\" IS NULL OR \"ventaId\" NOT IN (SELECT id FROM ventas))"
        )).rows;
        let creados = 0;
        for (const p of pedidos) {
            const vid = 'FAC-' + Date.now() + '-' + creados;
            await pool.query("INSERT INTO ventas (id,fecha,\"fechaTimestamp\",items,total,\"metodoPago\",logistica,cliente,estado,origen,\"pedidoId\") VALUES ($1,$2,$3,$4,$5,'pedido_online',$6,$7,'completada','tienda',$8)",
                [vid, p.fecha, p.fechatimestamp || Date.now(), p.items, p.total, p.tipoentrega==='envio'?'envio':'local', p.cliente, p.id]);
            await pool.query('UPDATE pedidos SET "ventaId"=$1 WHERE id=$2', [vid, p.id]);
            creados++;
        }
        res.json({ success: true, creados });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/rendimiento-productos', adminMiddleware(), async (req, res) => {
    try {
        const { desde, hasta } = req.body;
        let query = "SELECT * FROM ventas WHERE estado != 'cancelada'";
        let params = [];
        if (desde) { query += ` AND "fechaTimestamp" >= $${params.length+1}`; params.push(new Date(desde + 'T00:00:00').getTime()); }
        if (hasta) { query += ` AND "fechaTimestamp" <= $${params.length+1}`; params.push(new Date(hasta + 'T23:59:59').getTime()); }
        const ventas = (await pool.query(query, params)).rows;
        const ventasPorProducto = {};
        ventas.forEach(v => {
            const items = JSON.parse(v.items || '[]');
            items.forEach(it => {
                if (!it.pId) return;
                if (!ventasPorProducto[it.pId]) ventasPorProducto[it.pId] = { productoId: it.pId, nombre: it.pNom || '', unidades: 0, ingresos: 0, ventasAdmin: 0, ventasWeb: 0 };
                ventasPorProducto[it.pId].unidades += it.cant || 0;
                ventasPorProducto[it.pId].ingresos += (it.precio || 0) * (it.cant || 0);
                if (v.origen === 'admin') ventasPorProducto[it.pId].ventasAdmin += it.cant || 0;
                if (v.origen === 'tienda') ventasPorProducto[it.pId].ventasWeb += it.cant || 0;
            });
        });
        const totalIngresos = ventas.reduce((s, v) => s + (v.total || 0), 0);
        res.json({ rendimiento: Object.values(ventasPorProducto).sort((a,b) => b.ingresos - a.ingresos), totalVentas: ventas.length, totalIngresos });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/rendimiento-total', adminMiddleware(), async (req, res) => {
    try {
        const { desde, hasta } = req.body;
        let query = "SELECT * FROM ventas WHERE estado != 'cancelada'";
        let params = [];
        if (desde) { query += ` AND "fechaTimestamp" >= $${params.length+1}`; params.push(new Date(desde + 'T00:00:00').getTime()); }
        if (hasta) { query += ` AND "fechaTimestamp" <= $${params.length+1}`; params.push(new Date(hasta + 'T23:59:59').getTime()); }
        const ventas = (await pool.query(query, params)).rows;

        let gananciaMenor = 0, gananciaMayor = 0;
        let ingresosMenor = 0, ingresosMayor = 0;
        let unidadesMenor = 0, unidadesMayor = 0;
        let ventasConMenor = 0, ventasConMayor = 0;

        for (const v of ventas) {
            const items = JSON.parse(v.items || '[]');
            let esMayorVenta = false, esMenorVenta = false;
            for (const item of items) {
                if (!item.pId) continue;
                const costoResult = await pool.query(
                    'SELECT * FROM costos_productos WHERE "productoId"=$1 AND "fechaTimestamp" <= $2 ORDER BY "fechaTimestamp" DESC LIMIT 1',
                    [item.pId, v.fechaTimestamp]
                );
                const costo = costoResult.rows[0];
                const costoTotal = costo ? parseFloat(costo.costoTotal) : 0;
                const esMayoristaItem = !!(item.precioOriginal && item.precio < item.precioOriginal);
                const gananciaItem = ((parseFloat(item.precio)||0) - costoTotal) * (item.cant||1);
                const ingresoItem = (parseFloat(item.precio)||0) * (item.cant||1);
                if (esMayoristaItem) {
                    gananciaMayor += gananciaItem;
                    ingresosMayor += ingresoItem;
                    unidadesMayor += item.cant||0;
                    esMayorVenta = true;
                } else {
                    gananciaMenor += gananciaItem;
                    ingresosMenor += ingresoItem;
                    unidadesMenor += item.cant||0;
                    esMenorVenta = true;
                }
            }
            if (esMayorVenta) ventasConMayor++;
            if (esMenorVenta) ventasConMenor++;
        }

        res.json({
            gananciaMenor, gananciaMayor, gananciaTotal: gananciaMenor + gananciaMayor,
            ingresosMenor, ingresosMayor, ingresosTotal: ingresosMenor + ingresosMayor,
            unidadesMenor, unidadesMayor, unidadesTotal: unidadesMenor + unidadesMayor,
            ventasConMenor, ventasConMayor, totalVentas: ventas.length
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/verificar-password', adminMiddleware(), async (req, res) => {
    try {
        const { password } = req.body;
        const perfil = (await pool.query('SELECT * FROM perfiles WHERE id=$1', [req.admin.id])).rows[0];
        if (!perfil) return res.status(404).json({ error: 'Perfil no encontrado' });
        const valida = await bcrypt.compare(password, perfil.password);
        res.json({ valida });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/abrir-caja', adminMiddleware(), async (req, res) => {
    try {
        const abierta = (await pool.query("SELECT id FROM turnos_caja WHERE estado='abierto' LIMIT 1")).rows[0];
        if (abierta) return res.status(400).json({ error: 'Ya hay una caja abierta' });
        const id = 'CAJA-' + Date.now();
        const fecha = new Date().toLocaleString('es-AR', {timeZone:'America/Argentina/Buenos_Aires',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
        await pool.query(
            'INSERT INTO turnos_caja (id,"perfilId","perfilNombre","fechaApertura","timestampApertura","efectivoInicial",estado) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [id, req.admin.id, req.admin.nombre, fecha, Date.now(), parseFloat(req.body.efectivoInicial)||0, 'abierto']
        );
        await logActividad(req.admin.nombre, 'ABRIR_CAJA', `Caja abierta con $${req.body.efectivoInicial} de efectivo inicial`, req);
        res.json({ success: true, turnoId: id, fecha });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/estado-caja', adminMiddleware(), async (req, res) => {
    try {
        const turno = (await pool.query("SELECT * FROM turnos_caja WHERE estado='abierto' LIMIT 1")).rows[0];
        res.json({ abierta: !!turno, turno: turno || null });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/gasto-caja', adminMiddleware(), async (req, res) => {
    try {
        const turno = (await pool.query("SELECT id FROM turnos_caja WHERE estado='abierto' LIMIT 1")).rows[0];
        if (!turno) return res.status(400).json({ error: 'No hay caja abierta' });
        const id = 'GASTO-' + Date.now();
        const fecha = new Date().toLocaleString('es-AR', {timeZone:'America/Argentina/Buenos_Aires',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
        await pool.query(
            'INSERT INTO gastos_caja (id,"turnoId",descripcion,monto,fecha,"fechaTimestamp") VALUES ($1,$2,$3,$4,$5,$6)',
            [id, turno.id, req.body.descripcion, parseFloat(req.body.monto)||0, fecha, Date.now()]
        );
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/cerrar-caja', adminMiddleware(), async (req, res) => {
    try {
        const turno = (await pool.query("SELECT * FROM turnos_caja WHERE estado='abierto' LIMIT 1")).rows[0];
        if (!turno) return res.status(400).json({ error: 'No hay caja abierta' });
        const ts = turno.timestampApertura;
        const tsNow = Date.now();
        const [efRes, trRes, mixEfRes, mixTrRes, webRes, gastosRes] = await Promise.all([
            pool.query("SELECT COALESCE(SUM(total),0) as t FROM ventas WHERE \"metodoPago\"='efectivo' AND \"fechaTimestamp\">=$1 AND \"fechaTimestamp\"<=$2 AND origen='admin'", [ts, tsNow]),
            pool.query("SELECT COALESCE(SUM(total),0) as t FROM ventas WHERE \"metodoPago\"='transferencia' AND \"fechaTimestamp\">=$1 AND \"fechaTimestamp\"<=$2 AND origen='admin'", [ts, tsNow]),
            pool.query("SELECT COALESCE(SUM(\"montoEfectivo\"),0) as t FROM ventas WHERE \"metodoPago\"='mixto' AND \"fechaTimestamp\">=$1 AND \"fechaTimestamp\"<=$2 AND origen='admin'", [ts, tsNow]),
            pool.query("SELECT COALESCE(SUM(\"montoTransferencia\"),0) as t FROM ventas WHERE \"metodoPago\"='mixto' AND \"fechaTimestamp\">=$1 AND \"fechaTimestamp\"<=$2 AND origen='admin'", [ts, tsNow]),
            pool.query("SELECT COALESCE(SUM(total),0) as t FROM pedidos WHERE \"timestampAbono\">=$1 AND \"timestampAbono\"<=$2", [ts, tsNow]),
            pool.query("SELECT * FROM gastos_caja WHERE \"turnoId\"=$1", [turno.id])
        ]);
        const ventasEf = parseFloat(efRes.rows[0].t) + parseFloat(mixEfRes.rows[0].t);
        const ventasTr = parseFloat(trRes.rows[0].t) + parseFloat(mixTrRes.rows[0].t);
        const ventasWeb = parseFloat(webRes.rows[0].t);
        const gastos = gastosRes.rows;
        const totalGastos = gastos.reduce((s,g) => s+(g.monto||0), 0);
        const entregaEf = parseFloat(req.body.entregaEfectivo)||0;
        const entregaTr = parseFloat(req.body.entregaTransferencia)||0;
        const balanceEf = ventasEf - totalGastos - entregaEf;
        const balanceTr = (ventasTr + ventasWeb) - entregaTr;
        const fechaCierre = new Date().toLocaleString('es-AR', {timeZone:'America/Argentina/Buenos_Aires',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
        await pool.query(
            `UPDATE turnos_caja SET "perfilCierreId"=$1,"perfilCierreNombre"=$2,"fechaCierre"=$3,"timestampCierre"=$4,"entregaEfectivo"=$5,"entregaTransferencia"=$6,estado='cerrado' WHERE id=$7`,
            [req.admin.id, req.admin.nombre, fechaCierre, tsNow, entregaEf, entregaTr, turno.id]
        );
        await logActividad(req.admin.nombre, 'CERRAR_CAJA', `Caja ${turno.id} cerrada`, req);
        res.json({ success: true, ticket: {
            id: turno.id, perfilAbre: turno.perfilNombre, perfilCierra: req.admin.nombre,
            fechaApertura: turno.fechaApertura, fechaCierre,
            efectivoInicial: turno.efectivoInicial||0,
            ventasEfectivo: ventasEf, ventasTransferencia: ventasTr, ventasTransferenciaWeb: ventasWeb,
            gastos, totalGastos, entregaEfectivo: entregaEf, entregaTransferencia: entregaTr,
            balanceEfectivo: balanceEf, balanceTransferencia: balanceTr
        }});
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/historial-caja', adminMiddleware(), async (req, res) => {
    try {
        const { desde, hasta } = req.body;
        let q = "SELECT * FROM turnos_caja WHERE estado='cerrado'";
        let params = [];
        if (desde) { q += ` AND "timestampApertura">=$${params.length+1}`; params.push(new Date(desde).getTime()); }
        if (hasta) { q += ` AND "timestampCierre"<=$${params.length+1}`; params.push(new Date(hasta+'T23:59:59').getTime()); }
        q += ' ORDER BY "timestampCierre" DESC LIMIT 100';
        const turnos = (await pool.query(q, params)).rows;
        const historial = [];
        for (const t of turnos) {
            const ts = t.timestampApertura; const tsCierre = t.timestampCierre;
            const [efRes, trRes, mixEfRes, mixTrRes, webRes, gastosRes] = await Promise.all([
                pool.query("SELECT COALESCE(SUM(total),0) as t FROM ventas WHERE \"metodoPago\"='efectivo' AND \"fechaTimestamp\">=$1 AND \"fechaTimestamp\"<=$2 AND origen='admin'", [ts, tsCierre]),
                pool.query("SELECT COALESCE(SUM(total),0) as t FROM ventas WHERE \"metodoPago\"='transferencia' AND \"fechaTimestamp\">=$1 AND \"fechaTimestamp\"<=$2 AND origen='admin'", [ts, tsCierre]),
                pool.query("SELECT COALESCE(SUM(\"montoEfectivo\"),0) as t FROM ventas WHERE \"metodoPago\"='mixto' AND \"fechaTimestamp\">=$1 AND \"fechaTimestamp\"<=$2 AND origen='admin'", [ts, tsCierre]),
                pool.query("SELECT COALESCE(SUM(\"montoTransferencia\"),0) as t FROM ventas WHERE \"metodoPago\"='mixto' AND \"fechaTimestamp\">=$1 AND \"fechaTimestamp\"<=$2 AND origen='admin'", [ts, tsCierre]),
                pool.query("SELECT COALESCE(SUM(total),0) as t FROM pedidos WHERE \"timestampAbono\">=$1 AND \"timestampAbono\"<=$2", [ts, tsCierre]),
                pool.query("SELECT * FROM gastos_caja WHERE \"turnoId\"=$1", [t.id])
            ]);
            const ventasEf = parseFloat(efRes.rows[0].t) + parseFloat(mixEfRes.rows[0].t);
            const ventasTr = parseFloat(trRes.rows[0].t) + parseFloat(mixTrRes.rows[0].t);
            const ventasWeb = parseFloat(webRes.rows[0].t);
            const gastos = gastosRes.rows;
            const totalGastos = gastos.reduce((s,g) => s+(g.monto||0), 0);
            const balanceEf = ventasEf - totalGastos - (t.entregaEfectivo||0);
            const balanceTr = (ventasTr + ventasWeb) - (t.entregaTransferencia||0);
            historial.push({ id: t.id, perfilAbre: t.perfilNombre, perfilCierra: t.perfilCierreNombre,
                fechaApertura: t.fechaApertura, fechaCierre: t.fechaCierre,
                ticket: { id: t.id, perfilAbre: t.perfilNombre, perfilCierra: t.perfilCierreNombre,
                    fechaApertura: t.fechaApertura, fechaCierre: t.fechaCierre,
                    efectivoInicial: t.efectivoInicial||0, ventasEfectivo: ventasEf,
                    ventasTransferencia: ventasTr, ventasTransferenciaWeb: ventasWeb,
                    gastos, totalGastos, entregaEfectivo: t.entregaEfectivo||0,
                    entregaTransferencia: t.entregaTransferencia||0,
                    balanceEfectivo: balanceEf, balanceTransferencia: balanceTr }
            });
        }
        res.json({ historial });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Error interno' }); });

process.on('uncaughtException', (err) => {
    console.error('Error no capturado:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('Promesa rechazada:', reason);
});
async function start() {
    try {
        await initDB();
        await initConfig();
        await initMetodosEnvio();
        await initAdmin();
        try {
            await pool.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS "timestampAbono" BIGINT');
            await pool.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS comprobante TEXT DEFAULT \'\'');
            await pool.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS "comprobanteFecha" TEXT DEFAULT \'\'');
            await pool.query('ALTER TABLE ventas ADD COLUMN IF NOT EXISTS "canceladaPor" TEXT DEFAULT \'\'');
            await pool.query('ALTER TABLE ventas ADD COLUMN IF NOT EXISTS "fechaCancelacion" TEXT DEFAULT \'\'');
            await pool.query('ALTER TABLE ventas ADD COLUMN IF NOT EXISTS "montoEfectivo" REAL DEFAULT 0');
            await pool.query('ALTER TABLE ventas ADD COLUMN IF NOT EXISTS "montoTransferencia" REAL DEFAULT 0');
            await pool.query('ALTER TABLE ventas ADD COLUMN IF NOT EXISTS vendedor TEXT DEFAULT \'\'');
        } catch(e) {}
        
        // Agrega la columna si no existe
        try {
            await pool.query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS orden INTEGER DEFAULT 0');
            console.log('✅ Columna orden verificada');
        } catch(e) {
            console.log('⚠️ Error al agregar columna:', e.message);
        }
        
        app.listen(PORT, () => console.log(`\n🏪 CASA ELEGIDA - Puerto ${PORT}\n`));
    } catch(e) {
        console.error('Error al iniciar:', e.message);
        process.exit(1);
    }
}
start();

process.on('SIGTERM', () => { pool.end(); process.exit(0); });
process.on('SIGINT', () => { pool.end(); process.exit(0); });
