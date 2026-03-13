'use client'

import {useState, useRef, useCallback, useEffect} from 'react'
import ReactMarkdown from 'react-markdown'
import { FaFileAudio, FaPaperclip } from "react-icons/fa";
import { FaDownload } from "react-icons/fa6";
import styles from '../page.module.css'

interface CostData {
    totalEUR: number
    totalUSD: number
    inputTokens: number
    outputTokens: number
    model: string
}

interface HistoryItem {
    id: string
    timestamp: string
    content: string
    model: string
    cost?: CostData
    preview: string // Premier extrait de 100 caractères pour l'affichage
}

export default function VoiceRecorder() {
    const [isRecording, setIsRecording] = useState(false)
    const [isPaused, setIsPaused] = useState(false)
    const [status, setStatus] = useState('Cliquez pour commencer l\'enregistrement')
    const [transcript, setTranscript] = useState('')
    const [error, setError] = useState('')
    const [retryError, setRetryError] = useState('')
    const [costData, setCostData] = useState<CostData | null>(null)
    const [isProcessing, setIsProcessing] = useState(false)
    const [timer, setTimer] = useState('00:00')
    const [showRetryButton, setShowRetryButton] = useState(false)
    const [canDownload, setCanDownload] = useState(false)
    const [fileSize, setFileSize] = useState(0)
    const [fileSizeFormatted, setFileSizeFormatted] = useState('0 KB')
    const [history, setHistory] = useState<HistoryItem[]>([])
    const [expandedHistoryItems, setExpandedHistoryItems] = useState<Set<string>>(new Set())
    const [isEditing, setIsEditing] = useState(false)
    const [editBuffer, setEditBuffer] = useState('')
    const [showExamples, setShowExamples] = useState(true)
    const [hasInteracted, setHasInteracted] = useState(false)
    const [timeWarning, setTimeWarning] = useState(false)
    const [audioLevel, setAudioLevel] = useState(0)
    const [noAudioDetected, setNoAudioDetected] = useState(false)
    const [showAboutModal, setShowAboutModal] = useState(false)
    const [attachedDocuments, setAttachedDocuments] = useState<File[]>([])

    const mediaRecorderRef = useRef<MediaRecorder | null>(null)
    const audioChunksRef = useRef<Blob[]>([])
    const recordedAudioRef = useRef<Blob | null>(null)
    const startTimeRef = useRef<number>(0)
    const pausedTimeRef = useRef<number>(0)
    const timerIntervalRef = useRef<NodeJS.Timeout | null>(null)
    const fileInputRef = useRef<HTMLInputElement | null>(null)
    const docInputRef = useRef<HTMLInputElement | null>(null)
    const sizeCheckIntervalRef = useRef<NodeJS.Timeout | null>(null)
    const warningTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const autoStopTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const remainingTimeRef = useRef<number>(0)
    const audioContextRef = useRef<AudioContext | null>(null)
    const analyserRef = useRef<AnalyserNode | null>(null)
    const animationFrameRef = useRef<number | null>(null)
    const silenceCounterRef = useRef<number>(0)

    // Constantes pour les limites
    const MAX_FILE_SIZE_MB = 4 // Limite à 4Mo pour rester sous la limite Vercel de 4.5Mo
    const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024
    const MAX_RECORDING_DURATION_SECONDS = 15 * 60 // 15 minutes

    // Fonction pour formatter la taille de fichier
    const formatFileSize = useCallback((bytes: number) => {
        if (bytes === 0) return '0 B'
        const k = 1024
        const sizes = ['B', 'KB', 'MB', 'GB']
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
    }, [])

    // Arrêter le suivi de taille
    const stopSizeTracking = useCallback(() => {
        if (sizeCheckIntervalRef.current) {
            clearInterval(sizeCheckIntervalRef.current)
            sizeCheckIntervalRef.current = null
        }
    }, [])

    // Configurer les timeouts pour l'arrêt automatique à 15 minutes
    const setupAutoStopTimeouts = useCallback((delaySeconds: number) => {
        // Nettoyer les timeouts précédents
        if (warningTimeoutRef.current) clearTimeout(warningTimeoutRef.current)
        if (autoStopTimeoutRef.current) clearTimeout(autoStopTimeoutRef.current)

        const warningTime = 14 * 60 // 14 minutes en secondes
        const totalTime = MAX_RECORDING_DURATION_SECONDS

        // Avertissement à 14 minutes
        if (delaySeconds <= warningTime) {
            const warningDelay = (warningTime - delaySeconds) * 1000
            warningTimeoutRef.current = setTimeout(() => {
                setTimeWarning(true)
            }, warningDelay)
        }

        // Arrêt automatique à 15 minutes
        if (delaySeconds <= totalTime) {
            const stopDelay = (totalTime - delaySeconds) * 1000
            autoStopTimeoutRef.current = setTimeout(() => {
                finalStopRecording()
                setStatus('Arrêt automatique - Limite de 15 minutes atteinte')
            }, stopDelay)
        }
    }, [MAX_RECORDING_DURATION_SECONDS])

    // Nettoyer les timeouts d'arrêt automatique
    const clearAutoStopTimeouts = useCallback(() => {
        if (warningTimeoutRef.current) {
            clearTimeout(warningTimeoutRef.current)
            warningTimeoutRef.current = null
        }
        if (autoStopTimeoutRef.current) {
            clearTimeout(autoStopTimeoutRef.current)
            autoStopTimeoutRef.current = null
        }
        setTimeWarning(false)
    }, [])

    // Fonction pour monitorer le niveau audio
    const startAudioLevelMonitoring = useCallback(() => {
        if (!analyserRef.current) return

        let frameCount = 0
        const frequencyData = new Uint8Array(analyserRef.current.frequencyBinCount)

        const updateAudioLevel = () => {
            // Vérifier si on est toujours en enregistrement (vérifier directement le mediaRecorder plutôt que le state)
            if (!analyserRef.current || !mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') return

            analyserRef.current.getByteFrequencyData(frequencyData)
            // Calculer la moyenne mais ignorer les valeurs très basses (bruit de fond)
            const relevantData = frequencyData.filter(v => v > 10)
            const average = relevantData.length > 0
                ? relevantData.reduce((a, b) => a + b) / relevantData.length
                : 0
            // Appliquer une courbe exponentielle pour plus de sensibilité (surtout pour les faibles volumes)
            const level = Math.round(Math.pow((average / 255), 0.5) * 100)

            // Throttle les updates du state (toutes les 3 frames)
            frameCount++
            if (frameCount % 3 === 0) {
                setAudioLevel(level)

                // Détecter le silence (durée ~3 secondes à ~60fps = ~180 frames)
                if (level < 5) {
                    silenceCounterRef.current++
                    if (silenceCounterRef.current > 180) {
                        setNoAudioDetected(true)
                    }
                } else {
                    silenceCounterRef.current = 0
                    setNoAudioDetected(false)
                }
            }

            animationFrameRef.current = requestAnimationFrame(updateAudioLevel)
        }

        animationFrameRef.current = requestAnimationFrame(updateAudioLevel)
    }, [])

    const startTimer = useCallback(() => {
        startTimeRef.current = Date.now() - pausedTimeRef.current
        timerIntervalRef.current = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000)
            const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0')
            const seconds = (elapsed % 60).toString().padStart(2, '0')
            setTimer(`${minutes}:${seconds}`)
        }, 1000)
    }, [])

    const pauseTimer = useCallback(() => {
        if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current)
            timerIntervalRef.current = null
            pausedTimeRef.current = Date.now() - startTimeRef.current
        }
    }, [])

    const stopTimer = useCallback(() => {
        if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current)
            timerIntervalRef.current = null
        }
        pausedTimeRef.current = 0
        setTimer('00:00')
    }, [])

    // Fonction pour calculer la taille approximative pendant l'enregistrement
    const updateFileSize = useCallback(() => {
        if (audioChunksRef.current.length > 0) {
            const currentSize = audioChunksRef.current.reduce((total, chunk) => total + chunk.size, 0)
            setFileSize(currentSize)
            setFileSizeFormatted(formatFileSize(currentSize))

            // Arrêt automatique si on approche de la limite
            if (currentSize >= MAX_FILE_SIZE_BYTES) {
                console.log(`🛑 Arrêt automatique: limite de ${MAX_FILE_SIZE_MB}Mo atteinte (${formatFileSize(currentSize)})`)
                setStatus(`Arrêt automatique - Limite de ${MAX_FILE_SIZE_MB}Mo atteinte`)
            }
        }
    }, [formatFileSize, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB])

    // Démarrer le suivi de taille
    const startSizeTracking = useCallback(() => {
        setFileSize(0)
        setFileSizeFormatted('0 KB')
        sizeCheckIntervalRef.current = setInterval(updateFileSize, 1000) // Vérifier toutes les secondes
    }, [updateFileSize])

    const startRecording = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 16000 // 16kHz suffit pour la voix (vs 44.1kHz CD)
                }
            })

            // Tenter différents formats pour optimiser la compression
            let mimeType = 'audio/webm;codecs=opus'
            let mediaRecorderOptions: MediaRecorderOptions = {mimeType}

            // Essayer avec bitrate spécifique si supporté
            if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
                mediaRecorderOptions = {
                    mimeType: 'audio/webm;codecs=opus',
                    audioBitsPerSecond: 32000 // 32 kbps (vs ~128 kbps par défaut)
                }
            }

            mediaRecorderRef.current = new MediaRecorder(stream, mediaRecorderOptions)

            audioChunksRef.current = []

            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data)
                }
            }

            mediaRecorderRef.current.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, {type: 'audio/webm'})

                if (audioBlob.size === 0) {
                    setError('Enregistrement vide')
                    setStatus('Cliquez pour commencer l\'enregistrement')
                    return
                }

                recordedAudioRef.current = audioBlob
                // Traiter automatiquement avec Flash
                await processAudio()
            }

            mediaRecorderRef.current.start(100)
            setIsRecording(true)
            setStatus('Enregistrement en cours... Cliquez pour arrêter')
            setError('')
            setRetryError('')
            setAttachedDocuments([])
            setShowRetryButton(false)
            remainingTimeRef.current = 0
            silenceCounterRef.current = 0
            setAudioLevel(0)
            setNoAudioDetected(false)
            startTimer()
            startSizeTracking()
            setupAutoStopTimeouts(0)

            // Créer l'AudioContext et AnalyserNode pour le monitoring du niveau audio
            try {
                const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
                audioContextRef.current = audioContext

                // Reprendre l'AudioContext (peut être suspendu ou non selon le navigateur)
                // Appeler resume() inconditionnellement - c'est une no-op si déjà running
                if (audioContext.state !== 'closed') {
                    await audioContext.resume()
                }

                const analyser = audioContext.createAnalyser()
                analyser.fftSize = 2048  // Augmenter de 256 à 2048 pour meilleure précision
                analyserRef.current = analyser

                // Connecter la source audio à l'analyser
                const source = audioContext.createMediaStreamSource(stream)
                source.connect(analyser)

                // Créer un GainNode silencieux pour que le graphe audio soit valide
                // (l'analyser doit avoir une destination, mais on ne veut pas d'écho du micro)
                const silentGain = audioContext.createGain()
                silentGain.gain.value = 0
                analyser.connect(silentGain)
                silentGain.connect(audioContext.destination)

                // Petit délai pour que le flux audio soit prêt et que le state soit synchronisé
                await new Promise(resolve => setTimeout(resolve, 100))
                startAudioLevelMonitoring()
            } catch (e) {
                console.warn('Impossible de créer l\'AudioContext pour le monitoring:', e)
            }

        } catch (error) {
            console.error('Erreur d\'accès au microphone:', error)
            setError('Impossible d\'accéder au microphone. Vérifiez les permissions.')
        }
    }, [startTimer, startSizeTracking, setupAutoStopTimeouts, startAudioLevelMonitoring])

    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop()
            setIsRecording(false)
            stopTimer()

            // Arrêter le stream
            mediaRecorderRef.current.stream?.getTracks().forEach(track => track.stop())
        }
    }, [isRecording, stopTimer])

    const pauseRecording = useCallback(() => {
        if (mediaRecorderRef.current && isRecording && !isPaused) {
            mediaRecorderRef.current.pause()
            setIsPaused(true)
            setStatus('Enregistrement en pause - Cliquez pour reprendre')
            pauseTimer()
            // Pause les timeouts d'arrêt automatique
            if (warningTimeoutRef.current) clearTimeout(warningTimeoutRef.current)
            if (autoStopTimeoutRef.current) clearTimeout(autoStopTimeoutRef.current)
            // Suspend l'AudioContext
            if (audioContextRef.current) audioContextRef.current.suspend()
            // Arrêter l'animation frame
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
        }
    }, [isRecording, isPaused, pauseTimer])

    const resumeRecording = useCallback(async () => {
        if (mediaRecorderRef.current && isRecording && isPaused) {
            mediaRecorderRef.current.resume()
            setIsPaused(false)
            setStatus('Enregistrement en cours... Cliquez pour arrêter')
            startTimer()
            // Recalculer le temps écoulé et remettre en place les timeouts
            const elapsedSeconds = Math.floor(pausedTimeRef.current / 1000)
            setupAutoStopTimeouts(elapsedSeconds)
            // Resume l'AudioContext et attendre sa reprise
            if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
                await audioContextRef.current.resume()
            }
            // Redémarrer le monitoring audio
            startAudioLevelMonitoring()
        }
    }, [isRecording, isPaused, startTimer, setupAutoStopTimeouts, startAudioLevelMonitoring])

    const toggleRecording = useCallback(() => {
        if (isRecording) {
            if (isPaused) {
                resumeRecording()
            } else {
                pauseRecording()
            }
        } else {
            startRecording()
        }
    }, [isRecording, isPaused, startRecording, pauseRecording, resumeRecording])

    const finalStopRecording = useCallback(() => {
        if (mediaRecorderRef.current && (isRecording || isPaused)) {
            mediaRecorderRef.current.stop()
            setIsRecording(false)
            setIsPaused(false)
            setCanDownload(true)
            stopTimer()
            stopSizeTracking()
            clearAutoStopTimeouts()

            // Arrêter le monitoring audio
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current)
                animationFrameRef.current = null
            }
            if (audioContextRef.current) {
                audioContextRef.current.close()
                audioContextRef.current = null
            }
            analyserRef.current = null
            setAudioLevel(0)
            setNoAudioDetected(false)

            // Arrêter le stream
            mediaRecorderRef.current.stream?.getTracks().forEach(track => track.stop())
        }
    }, [isRecording, isPaused, stopTimer, stopSizeTracking, clearAutoStopTimeouts])

    const downloadRecording = useCallback(() => {
        if (recordedAudioRef.current) {
            const url = URL.createObjectURL(recordedAudioRef.current)
            const a = document.createElement('a')
            a.href = url
            a.download = `memo-vocal-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.webm`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
        }
    }, [])

    const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (file) {
            // Vérifier le type de fichier
            const validTypes = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/m4a', 'audio/aac']
            if (!validTypes.includes(file.type) && !file.name.match(/\.(wav|mp3|webm|ogg|m4a|aac)$/i)) {
                setError('Type de fichier non supporté. Utilisez WAV, MP3, WEBM, OGG, M4A ou AAC.')
                return
            }

            recordedAudioRef.current = file
            setCanDownload(false)
            setError('')
            setRetryError('')
            // Traiter automatiquement avec Flash
            await processAudio()
        }
        // Reset du input pour permettre de re-upload le même fichier
        if (event.target) {
            event.target.value = ''
        }
    }, [])

    const handleDocUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files
        if (files) {
            const validTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
            const validExtensions = /\.(pdf|png|jpg|jpeg|gif|docx|xlsx)$/i

            Array.from(files).forEach(file => {
                // Valider le type
                if (!validTypes.includes(file.type) && !validExtensions.test(file.name)) {
                    setError(`Fichier non supporté: ${file.name}. Utilisez PDF, PNG, JPG, GIF, DOCX ou XLSX.`)
                    return
                }

                // Vérifier la limite (5 documents max)
                setAttachedDocuments(prev => {
                    if (prev.length >= 5) {
                        setError('Limite de 5 documents atteinte')
                        return prev
                    }
                    return [...prev, file]
                })
            })
        }

        // Reset du input
        if (event.target) {
            event.target.value = ''
        }
    }, [])

    const removeDocument = useCallback((index: number) => {
        setAttachedDocuments(prev => prev.filter((_, i) => i !== index))
    }, [])

    // Détecter si le contenu ressemble à du Markdown
    const isMarkdown = useCallback((text: string) => {
        const markdownIndicators = [
            /^#{1,6}\s+/m,     // Titres
            /\*{1,2}.*\*{1,2}/, // Gras/italique
            /^[-*+]\s+/m,      // Listes
            /^\d+\.\s+/m,      // Listes numérotées
            /```[\s\S]*?```/,  // Code blocks
            /`[^`]+`/,         // Code inline
            /\[.*?\]\(.*?\)/   // Liens
        ]
        return markdownIndicators.some(pattern => pattern.test(text))
    }, [])


    // Copier le markdown brut (pour Notion)
    const copyMarkdown = useCallback(async () => {
        if (!transcript) return

        try {
            await navigator.clipboard.writeText(transcript)
        } catch (error) {
            console.error('Erreur de copie markdown:', error)
            setError('Impossible de copier dans le presse-papier')
        }
    }, [transcript])

    // Copier le texte formaté directement depuis la zone d'affichage
    const copyFormatted = useCallback(async () => {
        console.log('🔄 copyFormatted - Début')
        if (!transcript) {
            console.log('❌ Pas de transcript')
            return
        }

        try {
            let targetContainer: HTMLElement | null = null

            if (isMarkdown(transcript)) {
                // Chercher avec le module CSS
                targetContainer = document.querySelector(`[class*="markdown"]`) as HTMLElement
                if (!targetContainer) {
                    // Fallback: chercher directement dans le transcriptBox
                    targetContainer = document.querySelector(`[class*="transcriptBox"] [class*="markdown"]`) as HTMLElement
                }
            } else {
                targetContainer = document.querySelector(`[class*="plainText"]`) as HTMLElement
            }

            if (targetContainer) {
                // Sélectionner le contenu de la zone d'affichage
                const selection = window.getSelection()
                const range = document.createRange()
                range.selectNodeContents(targetContainer)
                selection?.removeAllRanges()
                selection?.addRange(range)

                // Utiliser execCommand pour copier le formatage riche
                const success = document.execCommand('copy')
                selection?.removeAllRanges()

                if (!success) {
                    throw new Error('execCommand failed')
                }
                console.log('✅ Copie réussie avec formatage')
            } else {
                console.log('❌ Container non trouvé, fallback vers clipboard.writeText')
                // Fallback si la zone n'est pas trouvée
                await navigator.clipboard.writeText(transcript)
            }

        } catch (error) {
            console.error('❌ Erreur de copie formatée:', error)
            // Fallback vers le markdown brut
            try {
                await navigator.clipboard.writeText(transcript)
                console.log('📋 Fallback vers markdown brut réussi')
            } catch (fallbackError) {
                console.error('❌ Fallback échoué aussi:', fallbackError)
                setError('Impossible de copier dans le presse-papier')
            }
        }
    }, [transcript, isMarkdown])

    // === FONCTIONS DE GESTION DE L'HISTORIQUE ===

    // Charger l'historique depuis localStorage
    useEffect(() => {
        try {
            const savedHistory = localStorage.getItem('voixla_history')
            if (savedHistory) {
                const parsedHistory: HistoryItem[] = JSON.parse(savedHistory)
                setHistory(parsedHistory.slice(0, 50)) // Limiter à 50 éléments
            }
        } catch (e) {
            console.warn('Erreur lors du chargement de l\'historique:', e)
        }
    }, [])

    // Sauvegarder une nouvelle transcription dans l'historique
    const saveToHistory = useCallback((content: string, model: string, cost?: CostData) => {
        if (!content || content.trim().length === 0) return

        const newItem: HistoryItem = {
            id: Date.now().toString(),
            timestamp: new Date().toISOString(),
            content: content.trim(),
            model,
            cost,
            preview: content.trim().substring(0, 100).replace(/\n/g, ' ')
        }

        setHistory(prevHistory => {
            const newHistory = [newItem, ...prevHistory].slice(0, 50) // Garder les 50 plus récents

            try {
                localStorage.setItem('voixla_history', JSON.stringify(newHistory))
                console.log(`💾 Transcription sauvegardée dans l'historique (${newHistory.length} éléments)`)
            } catch (e) {
                console.warn('Erreur lors de la sauvegarde:', e)
            }

            return newHistory
        })
    }, [])

    // Mettre à jour le dernier élément de l'historique avec le contenu corrigé
    const updateLastHistoryItem = useCallback((newContent: string) => {
        if (!newContent || newContent.trim().length === 0) return

        setHistory(prevHistory => {
            if (prevHistory.length === 0) return prevHistory

            const updatedHistory = [...prevHistory]
            const lastItem = updatedHistory[0]

            updatedHistory[0] = {
                ...lastItem,
                content: newContent.trim(),
                preview: newContent.trim().substring(0, 100).replace(/\n/g, ' ')
            }

            try {
                localStorage.setItem('voixla_history', JSON.stringify(updatedHistory))
                console.log('💾 Historique mis à jour avec les corrections')
            } catch (e) {
                console.warn('Erreur lors de la sauvegarde:', e)
            }

            return updatedHistory
        })
    }, [])

    // Valider l'édition du transcript
    const handleValidation = useCallback((contentToValidate?: string) => {
        const trimmedContent = (contentToValidate || editBuffer).trim()

        if (trimmedContent !== transcript) {
            // Contenu a été modifié (peut être vide)
            setTranscript(trimmedContent)

            // Mettre à jour l'historique SEULEMENT si contenu non-vide ET correspond au dernier item
            if (trimmedContent && history.length > 0 && history[0].content === transcript) {
                updateLastHistoryItem(trimmedContent)
                console.log('✅ Transcription IA éditée et sauvegardée')
            } else if (!trimmedContent) {
                console.log('ℹ️ Transcript vidé')
            } else {
                console.log('ℹ️ Texte manuel ou nouveau - pas de mise à jour historique')
            }
        }

        setIsEditing(false)
        setEditBuffer('')
    }, [editBuffer, transcript, history, updateLastHistoryItem])

    const processAudio = useCallback(async () => {
        if (!recordedAudioRef.current) return

        setIsProcessing(true)
        setStatus('Transcription en cours...')
        setError('')
        setRetryError('')
        setShowRetryButton(false)

        let result: any
        try {
            const formData = new FormData()

            // Validation côté client de la taille
            const fileSizeMB = recordedAudioRef.current.size / (1024 * 1024)
            if (fileSizeMB > 50) {
                throw new Error(`Fichier trop volumineux (${Math.round(fileSizeMB)}MB). Maximum: 50MB`)
            }

            formData.append('audio', recordedAudioRef.current, 'recording.webm')

            // Toujours envoyer le transcript existant (vide ou non)
            const existingText = transcript || ''
            formData.append('existingText', existingText)

            // Ajouter les documents attachés
            if (attachedDocuments.length > 0) {
                formData.append('documentCount', attachedDocuments.length.toString())
                attachedDocuments.forEach((doc, index) => {
                    formData.append(`document_${index}`, doc)
                })
            }

            const response = await fetch('/api/transcribe', {
                method: 'POST',
                body: formData,
                // Timeout côté client (5 minutes)
                signal: AbortSignal.timeout(5 * 60 * 1000)
            })

            const contentType = response.headers.get('content-type')

            if (contentType && contentType.includes('application/json')) {
                const textResponse = await response.text()
                try {
                    result = JSON.parse(textResponse)
                } catch (jsonError) {
                    console.error('Erreur parsing JSON:', textResponse.substring(0, 200))
                    throw new Error('Réponse malformée du serveur')
                }
            } else {
                // Si ce n'est pas du JSON, c'est probablement une erreur HTML
                const errorText = await response.text()
                throw new Error(`Erreur serveur: ${response.status} ${response.statusText}`)
            }

            if (response.ok && result.success) {
                setTranscript(result.content)
                setHasInteracted(true)
                setShowExamples(false)
                setIsEditing(false)
                setEditBuffer('')
                if (result.cost) {
                    setCostData(result.cost)
                }
                setStatus(`${existingText ? 'Transcription complétée' : 'Transcription terminée'}. Compléter votre transcription avec un nouvel enregistrement`)

                // Sauvegarder dans l'historique
                saveToHistory(result.content, 'flash', result.cost)

                // Vider les documents attachés après envoi
                setAttachedDocuments([])

            } else {
                throw new Error(result.error || `Erreur HTTP: ${response.status}`)
            }

        } catch (error: any) {
            console.error('Erreur:', error)

            // Erreurs spécifiquement connues comme retryables
            const isKnownRetryableError = error.message.includes('503') ||
                error.message.includes('overloaded') ||
                error.message.includes('500') ||
                error.message.includes('429') ||
                error.message.includes('502') ||
                error.message.includes('504') ||
                error.message.includes('timeout') ||
                error.message.includes('network')

            // Erreurs définitivement non-retryables
            const isNonRetryableError = error.message.includes('401') ||
                error.message.includes('403') ||
                error.message.includes('invalid') ||
                error.message.includes('not found') ||
                error.message.includes('permission') ||
                error.message.includes('unauthorized') ||
                error.message.includes('forbidden')

            if (isKnownRetryableError) {
                setRetryError(`Gemini Flash est surchargé. Vous pouvez ressayer dans quelques instants.`)
                setShowRetryButton(true)
                // En cas d'erreur, garder le transcript existant
                setCostData(null)
            } else if (isNonRetryableError) {
                // Erreurs définitives - pas de retry
                setError('Erreur lors de la transcription: ' + error.message)
                setCostData(null)
            } else {
                // Erreurs inconnues - proposer un retry par défaut
                setRetryError(`Une erreur inattendue s'est produite: ${error.message}. Vous pouvez essayer de relancer la transcription.`)
                setShowRetryButton(true)
                setCostData(null)
            }
        } finally {
            setIsProcessing(false)
            if (!retryError && !error) {
                // Changer le message selon s'il y a déjà une transcription ou non
                const newStatus = result && result.content ? 'Compléter votre transcription avec un nouvel enregistrement' : 'Cliquez pour commencer l\'enregistrement'
                setStatus(newStatus)
            }
        }
    }, [transcript, saveToHistory])

    const retryLastRequest = useCallback(async () => {
        if (!recordedAudioRef.current) return

        setShowRetryButton(false)
        await new Promise(resolve => setTimeout(resolve, 2000))
        await processAudio()
    }, [processAudio])

    // Supprimer un élément de l'historique
    const deleteFromHistory = useCallback((id: string) => {
        setHistory(prevHistory => {
            const newHistory = prevHistory.filter(item => item.id !== id)

            try {
                localStorage.setItem('voixla_history', JSON.stringify(newHistory))
            } catch (e) {
                console.warn('Erreur lors de la suppression:', e)
            }

            return newHistory
        })
    }, [])

    // Vider tout l'historique
    const clearHistory = useCallback(() => {
        setHistory([])
        setExpandedHistoryItems(new Set())
        try {
            localStorage.removeItem('voixla_history')
        } catch (e) {
            console.warn('Erreur lors du vidage:', e)
        }
    }, [])

    // Restaurer une transcription de l'historique
    const restoreFromHistory = useCallback((item: HistoryItem) => {
        setTranscript(item.content)
        setCostData(item.cost || null)
        setStatus('Transcription restaurée depuis l\'historique')

        // Scroll vers le haut pour voir la transcription restaurée
        window.scrollTo({top: 0, behavior: 'smooth'})
    }, [])

    // Toggle expansion d'un élément de l'historique
    const toggleHistoryExpansion = useCallback((id: string) => {
        setExpandedHistoryItems(prev => {
            const newSet = new Set(prev)
            if (newSet.has(id)) {
                newSet.delete(id)
            } else {
                newSet.add(id)
            }
            return newSet
        })
    }, [])

    // Commencer une nouvelle transcription (effacer l'existante)
    const startNewTranscription = useCallback(() => {
        setTranscript('')
        setEditBuffer('')
        setHasInteracted(false)
        setShowExamples(true)
        setCostData(null)
        setError('')
        setRetryError('')
        setShowRetryButton(false)
        setStatus('Cliquez pour commencer l\'enregistrement')
    }, [])

    return (
        <div className={styles.container}>
            <h1>🎙️ VoixLà</h1>

            {/* Boutons flottants en haut à droite */}
            <div className={styles.floatingButtonsContainer}>
                {/* Upload Button */}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*,.wav,.mp3,.webm,.ogg,.m4a,.aac"
                    onChange={handleFileUpload}
                    style={{display: 'none'}}
                />
                <button
                    onClick={() => fileInputRef.current?.click()}
                    className={styles.floatingIconButton}
                    title="Téléverser un fichier audio"
                >
                    <FaFileAudio />
                </button>

                {/* Document Upload Button */}
                <input
                    ref={docInputRef}
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.gif,.docx,.xlsx"
                    onChange={handleDocUpload}
                    multiple
                    style={{display: 'none'}}
                />
                <button
                    onClick={() => docInputRef.current?.click()}
                    className={styles.floatingIconButton}
                    title="Joindre un document"
                >
                    <FaPaperclip />
                </button>

                {/* Download Button */}
                {canDownload && recordedAudioRef.current && (
                    <button
                        onClick={downloadRecording}
                        className={styles.floatingIconButton}
                        title="Télécharger l'enregistrement"
                    >
                        <FaDownload />
                    </button>
                )}

                {/* New Transcription Button */}
                {transcript && !isRecording && !isPaused && !isProcessing && (
                    <button
                        onClick={startNewTranscription}
                        className={styles.floatingIconButton}
                        title="Nouvelle transcription"
                    >
                        🆕
                    </button>
                )}
            </div>

            {/* Section Audio Compacte */}
            <div className={styles.audioSection}>
                <div className={styles.recordingControls}>
                    <button
                        onClick={toggleRecording}
                        className={`${styles.recordButton} ${
                            isRecording ? (isPaused ? styles.paused : styles.recording) :
                                isProcessing ? styles.processing : styles.idle
                        }`}
                    >
                        {isRecording ? (isPaused ? '▶️' : '⏸️') : isProcessing ? '⏳' : '🎙️'}
                    </button>

                    {(isRecording || isPaused) && (
                        <button
                            onClick={finalStopRecording}
                            className={`${styles.stopButton}`}
                        >
                            ⏹️
                        </button>
                    )}

                    {/* Barre de niveau audio */}
                    {(isRecording || isPaused) && (
                        <div className={styles.audioLevelContainer}>
                            <div
                                className={styles.audioLevelBar}
                                style={{height: `${audioLevel}%`}}
                            ></div>
                        </div>
                    )}
                </div>

                <div className={styles.statusArea}>
                    <div className={`${styles.status} ${
                        isRecording ? (isPaused ? styles.paused : styles.recording) :
                            isProcessing ? styles.processing : styles.idle
                    }`}>
                        {status}
                    </div>

                    {(isRecording || isPaused) && (
                        <div className={styles.timer}>{timer}</div>
                    )}

                    {timeWarning && (
                        <div className={styles.timeWarning}>
                            ⏱️ Limite de 15 minutes approche
                        </div>
                    )}

                    {noAudioDetected && (
                        <div className={styles.audioWarning}>
                            🔇 Aucun son détecté
                        </div>
                    )}

                    {/* Documents attachés */}
                    {attachedDocuments.length > 0 && (
                        <div className={styles.attachedDocs}>
                            {attachedDocuments.map((doc, index) => (
                                <div key={index} className={styles.docChip}>
                                    <span>📎 {doc.name}</span>
                                    <button
                                        className={styles.docChipRemove}
                                        onClick={() => removeDocument(index)}
                                        title="Retirer ce document"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Barre de progression et taille fichier */}
                    {(isRecording || isPaused) && fileSize > 0 && (
                        <div className={styles.fileSizeSection}>
                            <div className={styles.fileSizeText}>
                                📁 {fileSizeFormatted} / {MAX_FILE_SIZE_MB} MB
                            </div>
                            <div className={styles.progressBarContainer}>
                                <div
                                    className={`${styles.progressBar} ${fileSize >= MAX_FILE_SIZE_BYTES * 0.8 ? styles.warning : ''} ${fileSize >= MAX_FILE_SIZE_BYTES * 0.95 ? styles.danger : ''}`}
                                    style={{width: `${Math.min((fileSize / MAX_FILE_SIZE_BYTES) * 100, 100)}%`}}
                                />
                            </div>
                            <div className={styles.progressText}>
                                {Math.round((fileSize / MAX_FILE_SIZE_BYTES) * 100)}%
                            </div>
                        </div>
                    )}
                </div>
                
                {/* Message d'information sur le mode complément */}
                {!isRecording && !isPaused && !isProcessing && transcript && (
                    <div className={styles.infoMessage}>
                        💡 Par défaut, un nouveau mémo complète la transcription existante
                    </div>
                )}
            </div>




            {/* Messages d'erreur et sélection de modèle */}
            <div className={styles.messagesSection}>
                {error && (
                    <div className={styles.error}>
                        {error}
                    </div>
                )}

                {retryError && (
                    <div className={styles.errorRetry}>
                        ⚠️ {retryError}
                        <br/>
                        {showRetryButton && (
                            <button onClick={retryLastRequest} className={styles.retryButton}>
                                🔄 Ressayer
                            </button>
                        )}
                    </div>
                )}
            </div>

            <div className={styles.transcriptSection}>
                <h3>Transcription :</h3>
                <div className={`${styles.transcriptBox} ${transcript ? styles.hasContent : ''} ${isEditing ? styles.editing : ''}`}
                    style={{ position: 'relative' }}>
                    {isProcessing ? (
                        <div className={styles.loading}>
                            <div className={styles.loader}></div>
                            Transcription en cours...
                        </div>
                    ) : (
                        <>
                            {/* Affichage des exemples */}
                            {showExamples && !transcript && !isEditing && (
                                <div className={styles.examples}>
                                    <div className={styles.exampleTitle}>💡 Exemples d'utilisation :</div>

                                    <div className={styles.exampleItem}>
                                        <strong>📧 Email professionnel :</strong><br/>
                                        "Rédige un email pour mon client, ton professionnel, pour reporter notre réunion de demain..."
                                    </div>

                                    <div className={styles.exampleItem}>
                                        <strong>📝 Article de blog :</strong><br/>
                                        "Écris un article sur les tendances IA 2025, style décontracté, 500 mots environ..."
                                    </div>

                                    <div className={styles.exampleItem}>
                                        <strong>💬 Message Slack :</strong><br/>
                                        "Résume les points clés de notre réunion d'équipe, format court pour Slack..."
                                    </div>

                                    <div className={styles.exampleItem}>
                                        <strong>📋 Rapport :</strong><br/>
                                        "Transforme mes notes en rapport structuré pour la direction, ton formel..."
                                    </div>
                                </div>
                            )}

                            {/* Affichage du contenu rendu (markdown ou texte) en lecture */}
                            {!isEditing && transcript && (
                                <>
                                    {isMarkdown(transcript) ? (
                                        <div className={styles.markdown}>
                                            <ReactMarkdown>
                                                {transcript}
                                            </ReactMarkdown>
                                        </div>
                                    ) : (
                                        <div className={styles.plainText}>
                                            {transcript.split('\n').map((line, index) => (
                                                <p key={index}>{line}</p>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}

                            {/* Zone éditable avec textarea */}
                            {isEditing && (
                                <textarea
                                    ref={(el) => {
                                        if (el && isEditing) {
                                            setTimeout(() => el.focus(), 0)
                                        }
                                    }}
                                    value={editBuffer}
                                    onChange={(e) => setEditBuffer(e.target.value)}
                                    className={styles.editableTranscript}
                                    style={{
                                        minHeight: '200px',
                                        padding: '12px',
                                        outline: 'none',
                                        whiteSpace: 'pre-wrap',
                                        wordWrap: 'break-word',
                                        textAlign: 'left',
                                        direction: 'ltr',
                                        width: '100%',
                                        boxSizing: 'border-box',
                                        backgroundColor: '#f9f9f9',
                                        border: '2px solid #4CAF50',
                                        borderRadius: '4px',
                                        fontFamily: 'inherit',
                                        fontSize: 'inherit',
                                        lineHeight: 'inherit'
                                    }}
                                />
                            )}
                        </>
                    )}

                    {/* Icône pencil/check pour contrôler le mode édition */}
                    {!isProcessing && (hasInteracted || isEditing || showExamples) && (
                        <button
                            onClick={() => {
                                if (isEditing) {
                                    // Mode édition: valider
                                    handleValidation(editBuffer)
                                } else {
                                    // Mode lecture: passer en édition
                                    setHasInteracted(true)
                                    setShowExamples(false)
                                    setIsEditing(true)
                                    setEditBuffer(transcript)
                                }
                            }}
                            className={styles.editIconButton}
                            title={isEditing ? 'Valider les modifications' : 'Éditer la transcription'}
                            onMouseDown={(e) => e.preventDefault()}
                            style={{
                                position: 'absolute',
                                top: '8px',
                                right: '8px',
                                width: '40px',
                                height: '40px',
                                borderRadius: '50%',
                                border: 'none',
                                backgroundColor: isEditing ? '#4CAF50' : '#2196F3',
                                color: 'white',
                                fontSize: '20px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                                transition: 'all 0.2s ease',
                                zIndex: 10
                            }}
                            onMouseOver={(e) => {
                                e.currentTarget.style.backgroundColor = isEditing ? '#45a049' : '#1976D2'
                                e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.25)'
                            }}
                            onMouseOut={(e) => {
                                e.currentTarget.style.backgroundColor = isEditing ? '#4CAF50' : '#2196F3'
                                e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.15)'
                            }}
                        >
                            {isEditing ? '✓' : '✏️'}
                        </button>
                    )}
                </div>

                {transcript && (
                    <>
                        <div className={styles.copyButtons}>
                            <button onClick={copyMarkdown} className={`${styles.copyButton} ${styles.notion}`}>
                                📝 Copier pour Notion (MD)
                            </button>
                            <button onClick={copyFormatted} className={`${styles.copyButton} ${styles.html}`}>
                                ✨ Copier pour Email/Word/Slack
                            </button>
                        </div>


                    </>
                )}

                {costData && (
                    <div className={styles.costInfo}>
                        💰 Coût: {costData.totalEUR.toFixed(6)}€ ({costData.model})
                    </div>
                )}
            </div>

            <a
                href="https://buymeacoffee.com/fpassx"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.coffeeButton}
            >
                Le service vous plait ? ☕ Offrez-moi un café 💕
            </a>

            {/* Section Historique */}
            {history.length > 0 && (
                <div className={styles.historySection}>
                    <div className={styles.historyHeader}>
                        <h3>📚 Historique des transcriptions ({history.length})</h3>
                        <button
                            onClick={clearHistory}
                            className={styles.clearHistoryButton}
                            title="Vider tout l'historique"
                        >
                            🗑️ Vider
                        </button>
                    </div>

                    <div className={styles.historyList}>
                        {history.map((item) => {
                            const isExpanded = expandedHistoryItems.has(item.id)
                            const date = new Date(item.timestamp)
                            const timeAgo = Math.round((Date.now() - date.getTime()) / (1000 * 60)) // minutes

                            return (
                                <div key={item.id} className={styles.historyItem}>
                                    <div
                                        className={styles.historyItemHeader}
                                        onClick={() => toggleHistoryExpansion(item.id)}
                                    >
                                        <div className={styles.historyItemInfo}>
                                            <div className={styles.historyItemPreview}>
                                                {item.preview}
                                                {item.content.length > 100 && '...'}
                                            </div>
                                            <div className={styles.historyItemMeta}>
                                                <span className={styles.modelBadge}>
                                                    ⚡ Flash
                                                </span>
                                                <span className={styles.historyTime}>
                                                    {timeAgo < 1 ? 'À l\'instant' :
                                                        timeAgo < 60 ? `${timeAgo}min` :
                                                            timeAgo < 1440 ? `${Math.round(timeAgo / 60)}h` :
                                                                `${Math.round(timeAgo / 1440)}j`}
                                                </span>
                                            </div>
                                        </div>
                                        <div className={styles.historyItemActions}>
                                            <button
                                                className={styles.expandButton}
                                                title={isExpanded ? 'Réduire' : 'Développer'}
                                            >
                                                {isExpanded ? '▼' : '▶'}
                                            </button>
                                        </div>
                                    </div>

                                    {isExpanded && (
                                        <div className={styles.historyItemContent}>
                                            <div className={styles.historyTranscript}>
                                                {isMarkdown(item.content) ? (
                                                    <div className={styles.markdown}>
                                                        <ReactMarkdown>{item.content}</ReactMarkdown>
                                                    </div>
                                                ) : (
                                                    <div className={styles.plainText}>
                                                        {item.content.split('\n').map((line, index) => (
                                                            <p key={index}>{line}</p>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>

                                            <div className={styles.historyItemFooter}>
                                                <div className={styles.historyButtons}>
                                                    <button
                                                        onClick={() => restoreFromHistory(item)}
                                                        className={`${styles.historyButton} ${styles.restore}`}
                                                        title="Restaurer cette transcription"
                                                    >
                                                        📄 Restaurer
                                                    </button>
                                                    <button
                                                        onClick={() => navigator.clipboard.writeText(item.content)}
                                                        className={`${styles.historyButton} ${styles.copy}`}
                                                        title="Copier cette transcription"
                                                    >
                                                        📋 Copier
                                                    </button>
                                                    <button
                                                        onClick={() => deleteFromHistory(item.id)}
                                                        className={`${styles.historyButton} ${styles.delete}`}
                                                        title="Supprimer cette transcription"
                                                    >
                                                        🗑️ Supprimer
                                                    </button>
                                                </div>

                                                {item.cost && (
                                                    <div className={styles.historyCost}>
                                                        💰 {item.cost.totalEUR.toFixed(6)}€
                                                    </div>
                                                )}

                                                <div className={styles.historyDate}>
                                                    📅 {date.toLocaleString('fr-FR')}
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </div>
            )}

            <footer className={styles.footer}>
                <div className={styles.footerContent}>
                    <div>🧪 <strong>VoixLà</strong> est une expérimentation en cours... mais on peut déjà se dire que c'est la meilleure app de la <strong>DicTech</strong> ! 🚀</div>
                    <div style={{marginTop: '15px', display: 'flex', gap: '12px', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap'}}>
                        <span className={styles.privacyBadge}>🔐 Données anonymes</span>
                        <button
                            onClick={() => setShowAboutModal(true)}
                            className={styles.aboutButton}
                        >
                            ℹ️ À propos
                        </button>
                    </div>
                </div>
            </footer>

            {/* Modal À propos */}
            {showAboutModal && (
                <div
                    className={styles.modalOverlay}
                    onClick={() => setShowAboutModal(false)}
                >
                    <div
                        className={styles.modalContent}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            className={styles.modalClose}
                            onClick={() => setShowAboutModal(false)}
                            aria-label="Fermer"
                        >
                            ✕
                        </button>

                        <h2>À propos de VoixLà</h2>

                        <div style={{textAlign: 'left', lineHeight: '1.6', color: '#555'}}>
                            <p>
                                <strong>VoixLà</strong> est une application simple et puissante de transcription vocale
                                alimentée par l'IA Gemini. Elle transforme vos memos vocaux en texte structuré prêt à être
                                utilisé, que ce soit pour des emails, des articles, des rapports, ou plus encore.
                            </p>

                            <h3 style={{marginTop: '20px', marginBottom: '10px', color: '#333'}}>🔒 Confidentialité</h3>
                            <ul style={{paddingLeft: '20px', margin: '10px 0'}}>
                                <li>Aucune donnée n'est stockée sur notre serveur</li>
                                <li>Aucun enregistrement audio ou transcription conservé</li>
                                <li>Vous restez entièrement maître de vos données</li>
                                <li>Utilisation 100% anonyme</li>
                            </ul>

                            <h3 style={{marginTop: '20px', marginBottom: '10px', color: '#333'}}>👤 Créateur</h3>
                            <p>Créé par <strong>Frédéric Passaniti</strong></p>

                            <h3 style={{marginTop: '20px', marginBottom: '10px', color: '#333'}}>🔗 Liens utiles</h3>
                            <div className={styles.modalLinks}>
                                <a href="https://www.linkedin.com/in/frederic-passaniti/" target="_blank" rel="noopener noreferrer">
                                    💼 LinkedIn
                                </a>
                                <a href="https://github.com/fpassaniti/" target="_blank" rel="noopener noreferrer">
                                    🐙 GitHub
                                </a>
                                <a href="https://github.com/fpassaniti/voixla" target="_blank" rel="noopener noreferrer">
                                    📦 Code source
                                </a>
                                <a href="https://buymeacoffee.com/fpassx" target="_blank" rel="noopener noreferrer">
                                    ☕ Buy me a coffee
                                </a>
                            </div>

                            <p style={{marginTop: '20px', fontSize: '0.9rem', color: '#999', textAlign: 'center'}}>
                                ✨ Open source et fait avec ❤️
                            </p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}