'use client';

import React, { useRef, useState, useEffect } from 'react';
import styles from '../page.module.css';
import {
  IconMic,
  IconPause,
  IconPlay,
  IconStop,
  IconCheck,
  IconX,
  IconPlus,
  IconPaperclip,
  IconUpload,
  IconDownload,
  IconCopy,
  IconPencil,
  IconSparkle,
  IconInfo,
  IconHistory,
  IconShield,
  IconTrash,
} from './Icons';
import { Waveform } from './Waveform';
import ReactMarkdown from 'react-markdown';

interface HistoryItem {
  id: string;
  timestamp: string;
  content: string;
  model: string;
  cost: { totalEUR: number; totalUSD: number };
  preview: string;
  duration: string;
  wordCount: number;
  date: string;
}

const EXAMPLES = [
  {
    tag: 'Brief',
    text: '« Rédige un email pour reporter la réunion de demain, ton professionnel… »',
  },
  {
    tag: 'Note',
    text: '« Résume les trois points clés de la discussion d\'hier avec l\'équipe design… »',
  },
  {
    tag: 'Idée',
    text: '« Article de blog sur la productivité vocale, 500 mots, ton décontracté… »',
  },
];

const COLOPHON_SPECS = [
  ['Moteur', 'Gemini Flash'],
  ['Langue', 'Français'],
  ['Limite', '15 minutes / enregistrement'],
  ['Formats', 'WAV, MP3, WEBM, M4A'],
  ['Pièces jointes', 'PDF, images, DOCX, XLSX'],
];

export default function VoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [timer, setTimer] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0.5);
  const [status, setStatus] = useState('');
  const [transcript, setTranscript] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [costData, setCostData] = useState<{
    totalEUR: number;
    totalUSD: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [retryError, setRetryError] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [attachedDocuments, setAttachedDocuments] = useState<File[]>([]);
  const [timeWarning, setTimeWarning] = useState(false);
  const [noAudioDetected, setNoAudioDetected] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recordedAudioRef = useRef<Blob | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const levelIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const attachFileInputRef = useRef<HTMLInputElement>(null);
  const importAudioInputRef = useRef<HTMLInputElement>(null);

  // Load history from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('voixla-history');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse history:', e);
      }
    }
  }, []);

  const handleRecord = async () => {
    if (isRecording || isPaused) {
      if (!isRecording && isPaused) {
        setIsRecording(true);
        setIsPaused(false);
      } else if (isRecording) {
        setIsRecording(false);
        setIsPaused(true);
      }
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      source.connect(analyser);

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
      });
      mediaRecorderRef.current = mediaRecorder;
      recordedAudioRef.current = null;

      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
      mediaRecorder.onstop = () => {
        recordedAudioRef.current = new Blob(chunks, { type: 'audio/webm' });
      };

      mediaRecorder.start();
      setIsRecording(true);
      setIsPaused(false);
      setTimer(0);
      setTimeWarning(false);
      setNoAudioDetected(false);

      timerIntervalRef.current = setInterval(() => {
        setTimer((t) => {
          const newTime = t + 1;
          if (newTime >= 14 * 60) {
            setTimeWarning(true);
          }
          if (newTime >= 15 * 60) {
            handleStop();
          }
          return newTime;
        });
      }, 1000);

      levelIntervalRef.current = setInterval(() => {
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length / 255;
        setAudioLevel(Math.max(0.1, average));
        if (average < 0.02) {
          setNoAudioDetected(true);
        } else {
          setNoAudioDetected(false);
        }
      }, 100);
    } catch (err) {
      setError('Impossible d\'accéder au microphone');
      console.error(err);
    }
  };

  const handleStop = () => {
    if (!isRecording && !isPaused) return;

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
    }
    if (levelIntervalRef.current) {
      clearInterval(levelIntervalRef.current);
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }

    setIsRecording(false);
    setIsPaused(false);
    setTimeout(() => transcribeAudio(), 100);
  };

  const transcribeAudio = async () => {
    if (!recordedAudioRef.current) {
      setError('Aucun audio enregistré');
      return;
    }

    setIsProcessing(true);
    setError('');
    setRetryError('');

    try {
      const formData = new FormData();
      formData.append('audio', recordedAudioRef.current, 'audio.webm');

      const textToExtend = editBuffer || transcript;
      if (textToExtend) {
        formData.append('existingText', textToExtend);
      }

      if (attachedDocuments.length > 0) {
        formData.append('documentCount', String(attachedDocuments.length));
        attachedDocuments.forEach((doc, i) => {
          formData.append(`document_${i}`, doc);
        });
      }

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (data.success) {
        const newTranscript = transcript && editBuffer ? editBuffer : data.content;
        setTranscript(newTranscript);
        setCostData(data.cost);

        const historyItem: HistoryItem = {
          id: Date.now().toString(),
          timestamp: new Date().toISOString(),
          content: newTranscript,
          model: data.cost.model || 'Gemini Flash',
          cost: {
            totalEUR: data.cost.totalEUR,
            totalUSD: data.cost.totalUSD,
          },
          preview: newTranscript.substring(0, 100),
          duration: `${Math.floor(timer / 60)}:${String(timer % 60).padStart(2, '0')}`,
          wordCount: newTranscript.split(/\s+/).length,
          date: new Date().toLocaleDateString('fr-FR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }),
        };

        const updatedHistory = [historyItem, ...history].slice(0, 100);
        setHistory(updatedHistory);
        localStorage.setItem('voixla-history', JSON.stringify(updatedHistory));

        setIsEditing(false);
        setEditBuffer('');
        setAttachedDocuments([]);
      } else {
        setError(data.error || 'Erreur lors de la transcription');
        setRetryError(data.error || 'Erreur lors de la transcription');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Erreur inconnue';
      setError(errorMsg);
      setRetryError(errorMsg);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleNew = () => {
    setTranscript('');
    setCostData(null);
    setTimer(0);
    setIsEditing(false);
    setEditBuffer('');
    recordedAudioRef.current = null;
    setAttachedDocuments([]);
  };

  const handleAttachFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      setAttachedDocuments([...attachedDocuments, ...files].slice(0, 5));
    }
    if (attachFileInputRef.current) {
      attachFileInputRef.current.value = '';
    }
  };

  const handleImportAudio = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      recordedAudioRef.current = file;
      setTimeout(() => transcribeAudio(), 100);
    }
    if (importAudioInputRef.current) {
      importAudioInputRef.current.value = '';
    }
  };

  const handleDownloadAudio = () => {
    if (!recordedAudioRef.current) return;
    const url = URL.createObjectURL(recordedAudioRef.current);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voixla-audio-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownload = () => {
    if (!transcript) return;
    const element = document.createElement('a');
    element.setAttribute(
      'href',
      `data:text/plain;charset=utf-8,${encodeURIComponent(transcript)}`
    );
    element.setAttribute('download', `voixla-${Date.now()}.txt`);
    element.style.display = 'none';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const handleCopyMarkdown = () => {
    navigator.clipboard.writeText(transcript).catch(() => {
      setError('Impossible de copier');
    });
  };

  const handleCopyPlain = () => {
    const plain = transcript
      .replace(/^#+ /gm, '')
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/^[-*\d.] /gm, '');
    navigator.clipboard.writeText(plain).catch(() => {
      setError('Impossible de copier');
    });
  };

  const handleRestoreHistory = (item: HistoryItem) => {
    setTranscript(item.content);
    setCostData(item.cost as any);
    recordedAudioRef.current = null;
    setAttachedDocuments([]);
    setShowHistoryDrawer(false);
  };

  const handleDeleteHistory = (id: string) => {
    const updated = history.filter((h) => h.id !== id);
    setHistory(updated);
    localStorage.setItem('voixla-history', JSON.stringify(updated));
  };

  const isMarkdown = (text: string) => {
    return /^[#*\-]|^\d+\.|[*_]|##/m.test(text);
  };

  const fmtTime = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const showingTranscript = !!transcript;

  return (
    <div className={styles.container}>
      <div className={styles.paperTexture} />

      {/* Header */}
      <div className={styles.header}>
        <div className={styles.logo}>
          <div>
            <div className={styles.logoBadge}>
              № 042 ·{' '}
              {new Date()
                .toLocaleDateString('fr-FR', { month: 'short', day: '2-digit' })
                .toUpperCase()}
            </div>
            <div className={styles.logotype}>
              Voix<span className={styles.logoAccent}>Là</span>
            </div>
          </div>
        </div>
        <div className={styles.headerPills}>
          <button
            className={`${styles.iconPill} ${showHistoryDrawer ? styles.active : ''}`}
            onClick={() => setShowHistoryDrawer(!showHistoryDrawer)}
          >
            <IconHistory size={18} weight={1.6} />
          </button>
          <button
            className={styles.iconPill}
            onClick={() => setShowAboutModal(true)}
          >
            <IconInfo size={18} weight={1.6} />
          </button>
        </div>
      </div>

      {/* Meta rule */}
      <div className={styles.metaRule}>
        <span>Transcription vocale · Gemini</span>
        <span>FR</span>
      </div>

      {/* Main content */}
      <div
        className={`${styles.content} ${
          showingTranscript ? styles.withTranscript : ''
        }`}
      >
        {!showingTranscript &&
          !isRecording &&
          !isPaused &&
          !isProcessing && (
            <div className={styles.emptyState}>
              <div className={styles.emptyHeading}>
                Parlez.
                <br />
                <span className={styles.emptyHeadingSecondary}>
                  Nous écrivons pour vous.
                </span>
              </div>
              <p className={styles.emptyDescription}>
                Un mémo vocal, une idée, un brouillon d'email. VoixLà
                transcrit, met en forme, et garde trace.
              </p>
              <div className={styles.examplesLabel}>Quelques idées —</div>
              <div className={styles.examplesList}>
                {EXAMPLES.map((ex, i) => (
                  <div key={i} className={styles.exampleItem}>
                    <div className={styles.exampleTag}>{ex.tag}</div>
                    <div className={styles.exampleText}>{ex.text}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

        {(isRecording || isPaused) && (
          <div className={styles.recordingPanel}>
            <div className={styles.timerDisplay}>{fmtTime(timer)}</div>
            <div className={styles.recordingStatus}>
              <div
                className={`${styles.recordingStatusDot} ${
                  isPaused ? styles.paused : ''
                }`}
              />
              {isPaused ? 'En pause' : 'Enregistrement'}
            </div>
            <div className={styles.waveformContainer}>
              <Waveform
                level={isPaused ? 0.15 : audioLevel}
                active={!isPaused}
                accent="var(--accent)"
              />
            </div>
            <div className={styles.recordingControls}>
              <button
                className={styles.iconPill}
                onClick={handleStop}
              >
                <IconStop size={20} weight={1.6} />
              </button>
              <button
                className={`${styles.recordButton} ${
                  isRecording ? styles.recording : styles.paused
                }`}
                onClick={handleRecord}
              >
                {isRecording ? (
                  <IconPause size={32} />
                ) : (
                  <IconPlay size={32} />
                )}
              </button>
              <button
                className={styles.iconPill}
              >
                <IconPaperclip size={20} weight={1.6} />
              </button>
            </div>
            <div className={styles.progressRail}>
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressBar}
                  style={{
                    width: `${Math.min((timer / (15 * 60)) * 100, 100)}%`,
                  }}
                />
              </div>
              <div className={styles.progressLabels}>
                <span>{fmtTime(timer)}</span>
                <span>LIMITE 15:00</span>
              </div>
            </div>
          </div>
        )}

        {isProcessing && (
          <div className={styles.processingState}>
            <div className={styles.processingDots}>
              <div className={styles.processingDot} />
              <div className={styles.processingDot} />
              <div className={styles.processingDot} />
            </div>
            <div className={styles.processingMessage}>Je mets en mots…</div>
            <div className={styles.processingCaption}>Gemini Flash</div>
          </div>
        )}

        {showingTranscript && !isProcessing && (
          <div>
            <div className={styles.transcriptMeta}>
              <div className={styles.transcriptMetaLeft}>
                <IconCheck size={12} color="var(--accent)" weight={2} />
                <span>Transcrit · {costData ? new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
              </div>
              <span>
                {transcript.split(/\s+/).length} mots ·{' '}
                {costData?.totalEUR.toFixed(3)}€
              </span>
            </div>

            <div
              className={`${styles.transcriptBox} ${
                isMarkdown(transcript) ? styles.markdown : styles.plainText
              }`}
            >
              {isEditing ? (
                <textarea
                  className={styles.editTextarea}
                  value={editBuffer}
                  onChange={(e) => setEditBuffer(e.target.value)}
                  autoFocus
                />
              ) : isMarkdown(transcript) ? (
                <ReactMarkdown>{transcript}</ReactMarkdown>
              ) : (
                <div>{transcript}</div>
              )}
            </div>

            <div className={styles.transcriptActions}>
              {isEditing ? (
                <>
                  <button
                    className={`${styles.actionChip} ${styles.primary}`}
                    onClick={() => {
                      setTranscript(editBuffer);
                      setIsEditing(false);
                    }}
                  >
                    <IconCheck size={14} weight={2} />
                    Valider
                  </button>
                  <button
                    className={styles.actionChip}
                    onClick={() => setIsEditing(false)}
                  >
                    <IconX size={14} weight={2} />
                    Annuler
                  </button>
                </>
              ) : (
                <>
                  <button
                    className={styles.actionChip}
                    onClick={handleCopyMarkdown}
                  >
                    <IconCopy size={14} weight={1.6} />
                    Copier MD
                  </button>
                  <button
                    className={styles.actionChip}
                    onClick={handleCopyPlain}
                  >
                    <IconCopy size={14} weight={1.6} />
                    Copier texte
                  </button>
                  <button
                    className={styles.actionChip}
                    onClick={handleDownload}
                  >
                    <IconDownload size={14} weight={1.6} />
                    Télécharger
                  </button>
                  <button
                    className={`${styles.actionChip} ${styles.primary}`}
                    onClick={handleNew}
                  >
                    <IconPlus size={14} weight={2} />
                    Nouveau
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom dock */}
      {!isRecording && !isPaused && (
        <div className={styles.bottomDock}>
          <div className={styles.bottomDockLabel}>
            {isProcessing
              ? 'Un instant…'
              : showingTranscript
                ? 'Compléter le mémo'
                : 'Appuyer pour parler'}
          </div>
          <div className={styles.bottomDockControls}>
            <button
              className={styles.iconPill}
              onClick={() => attachFileInputRef.current?.click()}
              title="Pièces jointes"
            >
              <IconPaperclip size={18} weight={1.6} />
            </button>
            <button
              className={`${styles.recordButton} ${
                isProcessing ? styles.processing : styles.idle
              }`}
              onClick={handleRecord}
            >
              {isProcessing ? (
                <IconSparkle size={34} />
              ) : (
                <IconMic size={34} weight={1.75} />
              )}
            </button>
            <button
              className={`${styles.iconPill} ${recordedAudioRef.current ? '' : styles.disabled}`}
              onClick={recordedAudioRef.current ? handleDownloadAudio : undefined}
              title="Télécharger audio"
              disabled={!recordedAudioRef.current}
            >
              <IconDownload size={18} weight={1.6} />
            </button>
          </div>
        </div>
      )}

      {/* History drawer */}
      {showHistoryDrawer && (
        <>
          <div
            className={styles.historyBackdrop}
            onClick={() => setShowHistoryDrawer(false)}
          />
          <div className={styles.historyDrawer}>
            <div className={styles.historyHandle}>
              <div className={styles.historyHandleBar} />
            </div>
            <div className={styles.historyHeader}>
              <div>
                <div className={styles.historyBadge}>
                  Journal · {history.length} entrées
                </div>
                <div className={styles.historyTitle}>Historique</div>
              </div>
              <button
                className={styles.iconPill}
                onClick={() => setShowHistoryDrawer(false)}
              >
                <IconX size={16} weight={1.8} />
              </button>
            </div>
            <div className={styles.historyList}>
              {history.map((item) => (
                <div
                  key={item.id}
                  className={styles.historyItem}
                  onClick={() => handleRestoreHistory(item)}
                >
                  <div className={styles.historyDuration}>{item.duration}</div>
                  <div className={styles.historyContent}>
                    <div className={styles.historyPreview}>{item.preview}</div>
                    <div className={styles.historyMeta}>
                      <span>{item.date}</span>
                      <span>·</span>
                      <span>{item.wordCount} mots</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* About modal (colophon) */}
      {showAboutModal && (
        <div
          className={styles.colophonBackdrop}
          onClick={() => setShowAboutModal(false)}
        >
          <div
            className={styles.colophonModal}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.colophonContent}>
              <div className={styles.colophonHeader}>
                <div>
                  <div className={styles.colophonBadge}>Colophon</div>
                  <div className={styles.colophonTitle}>À propos</div>
                </div>
                <button
                  className={styles.colophonCloseButton}
                  onClick={() => setShowAboutModal(false)}
                >
                  <IconX size={14} weight={1.8} />
                </button>
              </div>

              <p className={styles.colophonDescription}>
                VoixLà transforme votre voix en texte bien mis en forme. Un
                outil simple, rapide, pensé pour le quotidien — brouillons
                d'emails, notes, briefs, idées à la volée.
              </p>

              <div className={styles.colophonCallout}>
                <IconShield size={20} weight={1.6} color="var(--accent)" />
                <div>
                  <div className={styles.colophonCalloutTitle}>
                    Confidentialité
                  </div>
                  <div className={styles.colophonCalloutText}>
                    Aucun audio n'est stocké. L'historique reste sur votre
                    appareil.
                  </div>
                </div>
              </div>

              <div className={styles.colophonSpecLabel}>Spécifications —</div>
              <div className={styles.colophonSpecTable}>
                {COLOPHON_SPECS.map(([key, value], i) => (
                  <div key={i} className={styles.colophonSpecRow}>
                    <span className={styles.colophonSpecKey}>{key}</span>
                    <span className={styles.colophonSpecValue}>{value}</span>
                  </div>
                ))}
              </div>

              <div className={styles.colophonFooter}>
                Fait avec ♥ par Fred · v1.1.0
                {process.env.NEXT_PUBLIC_BUYMEACOFFEE_URL && (
                  <br/>
                )}
              </div>
              {process.env.NEXT_PUBLIC_BUYMEACOFFEE_URL && (
                <a
                  href={process.env.NEXT_PUBLIC_BUYMEACOFFEE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.coffeeButton}
                  style={{ display: 'block', marginLeft: 'auto', marginRight: 'auto' }}
                >
                  Le service vous plaît ? ☕ Offrez-moi un café 💕
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Hidden file inputs */}
      <input
        ref={attachFileInputRef}
        type="file"
        multiple
        accept=".pdf,.png,.jpg,.jpeg,.gif,.docx,.xlsx"
        onChange={handleAttachFiles}
        style={{ display: 'none' }}
      />
      <input
        ref={importAudioInputRef}
        type="file"
        accept=".wav,.mp3,.webm,.m4a,.ogg"
        onChange={handleImportAudio}
        style={{ display: 'none' }}
      />
    </div>
  );
}
