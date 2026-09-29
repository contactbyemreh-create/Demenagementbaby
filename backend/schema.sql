DROP TABLE IF EXISTS config;
CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'transparent',
  price_per_m3 REAL NOT NULL DEFAULT 28,
  price_per_km REAL NOT NULL DEFAULT 1.3,
  floor_rate_per_m3 REAL NOT NULL DEFAULT 1.4,
  margin_low REAL NOT NULL DEFAULT 0.9,
  margin_high REAL NOT NULL DEFAULT 1.15,
  opt_emballage REAL NOT NULL DEFAULT 180,
  opt_demontage REAL NOT NULL DEFAULT 90,
  opt_montemeuble REAL NOT NULL DEFAULT 150,
  opt_garde REAL NOT NULL DEFAULT 220,
  opt_nettoyage REAL NOT NULL DEFAULT 130,
  pro_email TEXT NOT NULL DEFAULT 'contact.byemreh@gmail.com',
  from_email TEXT NOT NULL DEFAULT 'onboarding@resend.dev',
  from_name TEXT NOT NULL DEFAULT 'Élan Déménagement'
);
INSERT INTO config (id) VALUES (1);

DROP TABLE IF EXISTS quotes;
CREATE TABLE quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  mode TEXT,
  logement_type TEXT,
  volume REAL,
  ville_depart TEXT,
  ville_arrivee TEXT,
  distance REAL,
  depart_floor INTEGER,
  depart_lift INTEGER,
  arrivee_floor INTEGER,
  arrivee_lift INTEGER,
  options TEXT,
  price_low REAL,
  price_high REAL,
  nom TEXT,
  email TEXT,
  tel TEXT,
  date_souhaitee TEXT
);

CREATE INDEX idx_quotes_created_at ON quotes(created_at);
