PRAGMA application_id = 0x53564C54; -- ASCII "SVLT"
PRAGMA user_version = 1;

CREATE TABLE vault_state (
    singleton                 INTEGER PRIMARY KEY CHECK (singleton = 1),
    password_wire_version     INTEGER NOT NULL
        CHECK (typeof(password_wire_version) = 'integer'
               AND password_wire_version BETWEEN 0 AND 4294967295),
    password_suite_id         INTEGER NOT NULL
        CHECK (typeof(password_suite_id) = 'integer'
               AND password_suite_id BETWEEN 0 AND 4294967295),
    password_envelope         BLOB NOT NULL
        CHECK (typeof(password_envelope) = 'blob'
               AND length(password_envelope) BETWEEN 1 AND 65536)
);

CREATE TABLE revisions (
    record_id                 BLOB NOT NULL
        CHECK (typeof(record_id) = 'blob' AND length(record_id) = 16),
    revision_id               BLOB NOT NULL
        CHECK (typeof(revision_id) = 'blob' AND length(revision_id) = 32),
    wire_version              INTEGER NOT NULL
        CHECK (typeof(wire_version) = 'integer'
               AND wire_version BETWEEN 0 AND 4294967295),
    suite_id                  INTEGER NOT NULL
        CHECK (typeof(suite_id) = 'integer'
               AND suite_id BETWEEN 0 AND 4294967295),
    key_epoch                 INTEGER NOT NULL
        CHECK (typeof(key_epoch) = 'integer'
               AND key_epoch BETWEEN 1 AND 4294967295),
    padding_bucket            INTEGER NOT NULL
        CHECK (typeof(padding_bucket) = 'integer'
               AND padding_bucket IN (1024, 4096, 16384, 61440)),
    envelope                  BLOB NOT NULL
        CHECK (typeof(envelope) = 'blob'
               AND length(envelope) BETWEEN 1 AND 65536),
    PRIMARY KEY (record_id, revision_id)
);

CREATE TABLE heads (
    record_id                 BLOB PRIMARY KEY
        CHECK (typeof(record_id) = 'blob' AND length(record_id) = 16),
    revision_id               BLOB NOT NULL
        CHECK (typeof(revision_id) = 'blob' AND length(revision_id) = 32),
    FOREIGN KEY (record_id, revision_id)
        REFERENCES revisions(record_id, revision_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE conflicts (
    record_id                 BLOB NOT NULL
        CHECK (typeof(record_id) = 'blob' AND length(record_id) = 16),
    candidate_revision_id     BLOB NOT NULL
        CHECK (typeof(candidate_revision_id) = 'blob'
               AND length(candidate_revision_id) = 32),
    expected_head_revision_id BLOB
        CHECK (expected_head_revision_id IS NULL
               OR (typeof(expected_head_revision_id) = 'blob'
                   AND length(expected_head_revision_id) = 32)),
    observed_head_revision_id BLOB NOT NULL
        CHECK (typeof(observed_head_revision_id) = 'blob'
               AND length(observed_head_revision_id) = 32),
    PRIMARY KEY (record_id, candidate_revision_id),
    FOREIGN KEY (record_id, candidate_revision_id)
        REFERENCES revisions(record_id, revision_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (record_id, expected_head_revision_id)
        REFERENCES revisions(record_id, revision_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (record_id, observed_head_revision_id)
        REFERENCES revisions(record_id, revision_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TRIGGER revisions_no_update
BEFORE UPDATE ON revisions
BEGIN
    SELECT RAISE(ABORT, 'immutable revisions');
END;

CREATE TRIGGER revisions_no_delete
BEFORE DELETE ON revisions
BEGIN
    SELECT RAISE(ABORT, 'immutable revisions');
END;

CREATE TRIGGER conflicts_no_update
BEFORE UPDATE ON conflicts
BEGIN
    SELECT RAISE(ABORT, 'immutable conflicts');
END;

CREATE TRIGGER conflicts_no_delete
BEFORE DELETE ON conflicts
BEGIN
    SELECT RAISE(ABORT, 'immutable conflicts');
END;
