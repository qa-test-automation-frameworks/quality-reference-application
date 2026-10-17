CREATE TABLE identities (
  namespace_id text NOT NULL,
  id uuid NOT NULL,
  identity_key text NOT NULL,
  role text NOT NULL CHECK (role IN ('member', 'reviewer')),
  display_name text NOT NULL,
  PRIMARY KEY (namespace_id, id),
  UNIQUE (namespace_id, identity_key)
);

CREATE TABLE policies (
  namespace_id text NOT NULL,
  id uuid NOT NULL,
  owner_id uuid NOT NULL,
  policy_number text NOT NULL,
  seed_version text NOT NULL,
  PRIMARY KEY (namespace_id, id),
  UNIQUE (namespace_id, policy_number),
  FOREIGN KEY (namespace_id, owner_id) REFERENCES identities(namespace_id, id)
);

CREATE TABLE claims (
  namespace_id text NOT NULL,
  id uuid NOT NULL,
  policy_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted', 'under_review', 'approved', 'rejected')),
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000),
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  category text NOT NULL CHECK (category IN ('auto', 'property_damage', 'theft')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, id),
  FOREIGN KEY (namespace_id, policy_id) REFERENCES policies(namespace_id, id),
  FOREIGN KEY (namespace_id, owner_id) REFERENCES identities(namespace_id, id)
);
CREATE INDEX claims_owner_created_idx ON claims(namespace_id, owner_id, created_at DESC);

CREATE TABLE claim_events (
  namespace_id text NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  claim_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  from_status text CHECK (from_status IN ('submitted', 'under_review', 'approved', 'rejected')),
  to_status text NOT NULL CHECK (to_status IN ('submitted', 'under_review', 'approved', 'rejected')),
  claim_version integer NOT NULL CHECK (claim_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, id),
  FOREIGN KEY (namespace_id, claim_id) REFERENCES claims(namespace_id, id),
  FOREIGN KEY (namespace_id, actor_id) REFERENCES identities(namespace_id, id)
);
CREATE INDEX claim_events_claim_idx ON claim_events(namespace_id, claim_id, claim_version);

CREATE TABLE sessions (
  namespace_id text NOT NULL,
  token_hash bytea NOT NULL,
  identity_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (namespace_id, token_hash),
  FOREIGN KEY (namespace_id, identity_id) REFERENCES identities(namespace_id, id) ON DELETE CASCADE
);
CREATE INDEX sessions_expiry_idx ON sessions(namespace_id, expires_at);
