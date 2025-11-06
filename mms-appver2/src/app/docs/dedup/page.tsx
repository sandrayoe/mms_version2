"use server";

import React from "react";
import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), '.analysis', 'plots');

export default async function DedupProofPage() {
  let pngBase64: string | null = null;
  let csvText: string | null = null;
  let proofText: string | null = null;

  try {
    const pngPath = path.join(DATA_DIR, 'duplicate_groups.png');
    const png = await fs.readFile(pngPath);
    pngBase64 = png.toString('base64');
  } catch (e) {
    // file may not exist in some workspaces; we'll show a friendly message
    pngBase64 = null;
  }

  try {
    const csvPath = path.join(DATA_DIR, 'duplicate_groups.csv');
    csvText = await fs.readFile(csvPath, 'utf-8');
  } catch (e) {
    csvText = null;
  }

  try {
    const txtPath = path.join(DATA_DIR, 'dedupe_proof.txt');
    proofText = await fs.readFile(txtPath, 'utf-8');
  } catch (e) {
    proofText = null;
  }

  return (
    <div style={{ padding: 24, maxWidth: 980, margin: '0 auto', fontFamily: 'Segoe UI, Roboto, Arial, sans-serif' }}>
      <h1>Deduplication evidence</h1>

      <p>
        This page shows concrete proof that identical spike payloads were recorded multiple times in the
        provided recording data. See the details: 
      </p>

      {pngBase64 ? (
        <div style={{ marginTop: 16 }}>
          <h3>Top duplicate groups (bar chart)</h3>
          <img src={`data:image/png;base64,${pngBase64}`} alt="duplicate groups" style={{ maxWidth: '100%', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }} />
        </div>
      ) : (
        <div style={{ marginTop: 16, color: '#a00' }}>duplicate_groups.png not found at <code>{DATA_DIR}</code></div>
      )}

      <div style={{ marginTop: 20 }}>
        {csvText ? (
          <a
            href={`data:text/csv;base64,${Buffer.from(csvText).toString('base64')}`}
            download="duplicate_groups.csv"
            style={{ display: 'inline-block', marginRight: 12 }}
          >
            Download duplicate_groups.csv
          </a>
        ) : (
          <span style={{ color: '#a00' }}>duplicate_groups.csv not found</span>
        )}

        {proofText ? (
          <>
            <span style={{ margin: '0 8px' }}>|</span>
            <a
              href={`data:text/plain;base64,${Buffer.from(proofText).toString('base64')}`}
              download="dedupe_proof.txt"
            >
              Download dedupe_proof.txt
            </a>
          </>
        ) : null}
      </div>

      {proofText ? (
        <div style={{ marginTop: 20, padding: 12, background: '#f6f8fa', borderRadius: 6, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
          <h3>Concrete examples (excerpt)</h3>
          <div>{proofText}</div>
        </div>
      ) : null}

      <div style={{ marginTop: 28, color: '#666' }}>
        //last edited - 6/11/2025
      </div>
    </div>
  );
}
