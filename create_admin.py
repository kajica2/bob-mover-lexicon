#!/usr/bin/env python3
"""
Create or update an admin user for the server-side etude store.

Usage:
  python3 create_admin.py <username> <password>     # create
  python3 create_admin.py <username> <password> --force  # overwrite
  python3 create_admin.py <username>                # update password (interactive)
  python3 create_admin.py --list                    # show all users

The admin user can:
  - Save / list / rename / delete etudes server-side (the etudes
    persist across devices/browsers; the per-browser IndexedDB is
    still used for anonymous users).
  - Edit exercises.json / musicxml / exercises_images / chords.json
    via future admin endpoints (the API surface is in place; the
    data-edit UI ships in a follow-up).

Passwords are stored as PBKDF2-HMAC-SHA256 hashes (200k iterations,
16-byte salt) — see db.py for the full scheme.
"""
import argparse
import getpass
import sys

import db


def main():
    p = argparse.ArgumentParser()
    p.add_argument("username", nargs="?", help="Admin username (omit to list)")
    p.add_argument("password", nargs="?", help="Admin password (omit to be prompted)")
    p.add_argument("--force", action="store_true",
                   help="If the user exists, overwrite the password (default: refuse)")
    p.add_argument("--list", action="store_true", help="List all users and exit")
    p.add_argument("--role", default="admin",
                   help="Role to assign (default: admin). Use 'user' for non-admin accounts.")
    args = p.parse_args()

    if args.list:
        with db.get_db() as conn:
            c = conn.cursor()
            c.execute("SELECT id, username, role, created_at FROM users ORDER BY id")
            rows = c.fetchall()
        if not rows:
            print("(no users yet)")
            return
        for r in rows:
            print(f'  {r["id"]:>3}  {r["username"]:<20}  {r["role"]:<8}  {r["created_at"]}')
        return

    if not args.username:
        p.error("username is required (or use --list)")

    # Check if the user already exists
    existing = db.get_user_by_username(args.username)

    if existing:
        if not args.force and args.password is None:
            print(f"User {args.username!r} already exists (id={existing['id']}, role={existing['role']}).")
            print("Pass a password argument to update it, or use --force to overwrite.")
            sys.exit(1)
        pw = args.password
        if pw is None:
            pw = getpass.getpass("New password: ")
            pw2 = getpass.getpass("Confirm: ")
            if pw != pw2:
                print("Passwords do not match.", file=sys.stderr)
                sys.exit(1)
        db.set_user_password(existing["id"], pw)
        if existing["role"] != args.role:
            db.set_user_role(existing["id"], args.role)
        print(f"Updated user {args.username!r} (id={existing['id']}, role={args.role}).")
        return

    if args.password is None:
        pw = getpass.getpass("Password: ")
        pw2 = getpass.getpass("Confirm: ")
        if pw != pw2:
            print("Passwords do not match.", file=sys.stderr)
            sys.exit(1)
    else:
        pw = args.password
    if len(pw) < 8:
        print("Password must be at least 8 characters.", file=sys.stderr)
        sys.exit(1)

    user_id = db.create_user(args.username, pw, role=args.role)
    print(f"Created user {args.username!r} (id={user_id}, role={args.role}).")


if __name__ == "__main__":
    main()
