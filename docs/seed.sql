

begin;

-- Extensión para gen_random_uuid() (disponible en Supabase).
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- User
-- -----------------------------------------------------------------------------
create table if not exists "User" (
    id             uuid        primary key default gen_random_uuid(),
    email          text        not null,
    password_hash  text        not null,                 -- Argon2id (nunca en claro)
    rol            text        not null check (rol in ('ADMIN', 'SOCIO', 'ALUMNO')),
    email_verified boolean     not null default false,
    created_at     timestamptz not null default now()
);

-- Email normalizado como identificador de login: único sobre lower(email).
create unique index if not exists user_email_lower_uk on "User" (lower(email));

-- -----------------------------------------------------------------------------
-- Edition
-- -----------------------------------------------------------------------------
create table if not exists "Edition" (
    id           uuid        primary key default gen_random_uuid(),
    nombre       text        not null,
    anio         int         not null,
    fecha_inicio date,
    fecha_fin    date,
    estado       text        not null default 'abierta' check (estado in ('abierta', 'cerrada'))
);

-- -----------------------------------------------------------------------------
-- Company
-- -----------------------------------------------------------------------------
create table if not exists "Company" (
    id         uuid    primary key default gen_random_uuid(),
    nombre     text    not null,
    es_socia   boolean not null default false,
    contacto   text,
    created_by uuid    references "User" (id) on delete set null   -- admin que la creó
);

-- -----------------------------------------------------------------------------
-- Student (1:1 con User; pertenece a una Edition; opcionalmente empleado en Company socia)
-- -----------------------------------------------------------------------------
create table if not exists "Student" (
    id                      uuid        primary key default gen_random_uuid(),
    user_id                 uuid        not null unique references "User" (id) on delete cascade,
    edition_id              uuid        not null references "Edition" (id) on delete restrict,
    current_company_id      uuid        references "Company" (id) on delete set null,
    nombre                  text        not null,
    foto_url                text,
    bio                     text,
    ubicacion               text,
    disponibilidad_traslado boolean     not null default false,   -- dispuesto a trasladarse geográficamente
    modalidad               text        check (modalidad in ('remoto', 'presencial', 'hibrido')),
    estado_laboral          text        check (estado_laboral in ('buscando', 'trabajando')),
    cv_url                  text,
    linkedin                text,
    github                  text,
    consent_at              timestamptz,                          -- null si no ha consentido
    estado                  text        not null default 'inactivo' check (estado in ('activo', 'inactivo')),
    privacy                 jsonb       not null default '{}'::jsonb,  -- visibilidad por campo
    filled_at               timestamptz,
    created_at              timestamptz not null default now()
);

create index if not exists student_edition_idx         on "Student" (edition_id);
create index if not exists student_estado_idx          on "Student" (estado);
create index if not exists student_current_company_idx on "Student" (current_company_id);

-- -----------------------------------------------------------------------------
-- Skill + Skill_student_rel (N:M)
-- -----------------------------------------------------------------------------
create table if not exists "Skill" (
    id     uuid primary key default gen_random_uuid(),
    nombre text not null unique
);

create table if not exists "Skill_student_rel" (
    skill_id   uuid not null references "Skill" (id)   on delete cascade,
    student_id uuid not null references "Student" (id) on delete cascade,
    nivel      text check (nivel in ('basico', 'medio', 'avanzado')),
    primary key (skill_id, student_id)
);

create index if not exists skill_student_rel_student_idx on "Skill_student_rel" (student_id);

-- -----------------------------------------------------------------------------
-- Language + Language_student_rel (N:M)
-- -----------------------------------------------------------------------------
create table if not exists "Language" (
    id     uuid primary key default gen_random_uuid(),
    nombre text not null unique
);

create table if not exists "Language_student_rel" (
    language_id uuid not null references "Language" (id) on delete cascade,
    student_id  uuid not null references "Student" (id)  on delete cascade,
    nivel       text check (nivel in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'nativo')),
    primary key (language_id, student_id)
);

create index if not exists language_student_rel_student_idx on "Language_student_rel" (student_id);

-- -----------------------------------------------------------------------------
-- Project
-- -----------------------------------------------------------------------------
create table if not exists "Project" (
    id            uuid        primary key default gen_random_uuid(),
    student_id    uuid        not null references "Student" (id) on delete cascade,
    titulo        text        not null,
    descripcion   text,
    url           text        not null,                 -- repo o web válida
    thumbnail_url text,                                  -- subida manual (1ª iteración)
    created_at    timestamptz not null default now()
);

create index if not exists project_student_idx on "Project" (student_id);

-- -----------------------------------------------------------------------------
-- Company_user_rel (N:M: usuarios SOCIO <-> empresas)
-- -----------------------------------------------------------------------------
create table if not exists "Company_user_rel" (
    company_id uuid not null references "Company" (id) on delete cascade,
    user_id    uuid not null references "User" (id)    on delete cascade,
    primary key (company_id, user_id)
);

create index if not exists company_user_rel_user_idx on "Company_user_rel" (user_id);

-- -----------------------------------------------------------------------------
-- Company_student_rel (N:M: bookmarks de empresas sobre alumnos)
-- -----------------------------------------------------------------------------
create table if not exists "Company_student_rel" (
    company_id uuid        not null references "Company" (id) on delete cascade,
    student_id uuid        not null references "Student" (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (company_id, student_id)
);

create index if not exists company_student_rel_student_idx on "Company_student_rel" (student_id);

-- -----------------------------------------------------------------------------
-- Session (sesiones opacas en servidor; se guarda SOLO el SHA-256 del token)
-- -----------------------------------------------------------------------------
create table if not exists "Session" (
    id           uuid        primary key default gen_random_uuid(),
    user_id      uuid        not null references "User" (id) on delete cascade,
    token_sha256 text        not null unique,            -- SHA-256 hex del token opaco
    expires_at   timestamptz not null,
    created_at   timestamptz not null default now()
);

create index if not exists session_user_idx    on "Session" (user_id);
create index if not exists session_expires_idx on "Session" (expires_at);

-- -----------------------------------------------------------------------------
-- Email_verification_token (token de un solo uso)
-- -----------------------------------------------------------------------------
create table if not exists "Email_verification_token" (
    id           uuid        primary key default gen_random_uuid(),
    user_id      uuid        not null references "User" (id) on delete cascade,
    token_sha256 text        not null unique,            -- SHA-256 hex, un solo uso
    expires_at   timestamptz not null,
    used_at      timestamptz,                            -- null si no usado
    created_at   timestamptz not null default now()
);

create index if not exists email_verification_token_user_idx on "Email_verification_token" (user_id);

-- -----------------------------------------------------------------------------
-- Reminder_state (1:1 con Student; ciclo de recordatorios)
-- -----------------------------------------------------------------------------
create table if not exists "Reminder_state" (
    student_id             uuid        primary key references "Student" (id) on delete cascade,
    invited_at             timestamptz,
    recordatorios_enviados int         not null default 0,
    filled_at              timestamptz,
    estado                 text        not null default 'pendiente' check (estado in ('pendiente', 'completado', 'inactivo'))
);

-- -----------------------------------------------------------------------------
-- Audit_log (trazabilidad de mutaciones; NUNCA guardar el hash de contraseña)
-- -----------------------------------------------------------------------------
create table if not exists "Audit_log" (
    id               uuid        primary key default gen_random_uuid(),
    id_usuario       uuid        references "User" (id) on delete set null,  -- null si lo genera el sistema
    tabla            text        not null,
    id_registro      uuid,
    operacion        text        not null check (operacion in ('INSERT', 'UPDATE', 'DELETE')),
    datos_anteriores jsonb,
    datos_nuevos     jsonb,
    "timestamp"      timestamptz not null default now()
);

create index if not exists audit_log_usuario_idx on "Audit_log" (id_usuario);
create index if not exists audit_log_tabla_idx   on "Audit_log" (tabla, id_registro);

-- =============================================================================
-- Seguridad (Supabase): habilitar RLS en todas las tablas.
-- No se definen políticas => el API público de Supabase (anon/authenticated)
-- NO puede leer ni escribir. El acceso se hace desde el backend (Hono) con la
-- service_role / conexión directa, que omite RLS, y es ahí donde se autoriza
-- con el Actor {id, rol}. RLS actúa como segunda barrera.
-- =============================================================================
alter table "User"                     enable row level security;
alter table "Session"                  enable row level security;
alter table "Email_verification_token" enable row level security;
alter table "Edition"                  enable row level security;
alter table "Company"                  enable row level security;
alter table "Student"                  enable row level security;
alter table "Skill"                    enable row level security;
alter table "Skill_student_rel"        enable row level security;
alter table "Language"                 enable row level security;
alter table "Language_student_rel"     enable row level security;
alter table "Project"                  enable row level security;
alter table "Company_user_rel"         enable row level security;
alter table "Company_student_rel"      enable row level security;
alter table "Reminder_state"           enable row level security;
alter table "Audit_log"                enable row level security;

-- =============================================================================
-- Datos de referencia (seed). Idempotente con ON CONFLICT.
-- =============================================================================

-- Skills frecuentes
insert into "Skill" (nombre) values
    ('JavaScript'), ('TypeScript'), ('HTML'), ('CSS'), ('Node.js'),
    ('Hono'), ('React'), ('Vue'), ('Angular'), ('Python'),
    ('Java'), ('PHP'), ('SQL'), ('PostgreSQL'), ('MongoDB'),
    ('Git'), ('Docker'), ('REST API')
on conflict (nombre) do nothing;

-- Idiomas
insert into "Language" (nombre) values
    ('Español'), ('Catalán'), ('Inglés'), ('Francés'),
    ('Alemán'), ('Italiano'), ('Portugués')
on conflict (nombre) do nothing;

-- Edición de ejemplo (descomentar/ajustar si se desea)
-- insert into "Edition" (nombre, anio, fecha_inicio, fecha_fin, estado) values
--     ('Xarxatec Activa 2025', 2025, '2025-01-01', '2025-06-30', 'cerrada');

-- Usuario administrador inicial.
-- El password_hash debe generarse con Argon2id (m=19456, t=2, p=1) desde el
-- backend; NO se incluye un hash de ejemplo. Alta del staff = operación aparte.
-- insert into "User" (email, password_hash, rol, email_verified) values
--     ('admin@xarxatec.org', '<ARGON2ID_HASH>', 'ADMIN', true);

commit;
