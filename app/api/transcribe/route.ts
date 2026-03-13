import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'

// Dynamic imports for document processing
let mammoth: any = null
let ExcelJS: any = null

async function initDocumentProcessors() {
  if (!mammoth) {
    try {
      mammoth = await import('mammoth')
    } catch (e) {
      console.warn('mammoth not installed')
    }
  }
  if (!ExcelJS) {
    try {
      ExcelJS = await import('exceljs')
    } catch (e) {
      console.warn('exceljs not installed')
    }
  }
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

export async function POST(request: NextRequest) {
  try {
    // Timeout pour les requêtes longues (10 minutes)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000)
    
    const formData = await request.formData()
    const audioFile = formData.get('audio') as File
    const existingTextRaw = formData.get('existingText')
    const existingText = existingTextRaw ? String(existingTextRaw) : null
    
    if (!audioFile) {
      clearTimeout(timeout)
      return NextResponse.json(
        { error: 'Aucun fichier audio fourni' },
        { status: 400 }
      )
    }

    // Initialize document processors
    await initDocumentProcessors()

    // Validation de la taille - audio max 4MB (déjà géré côté client), total max 30MB (limite Cloud Run)
    const maxTotalSize = 30 * 1024 * 1024 // 30MB total
    const maxAudioSize = 4 * 1024 * 1024 // 4MB pour l'audio

    if (audioFile.size > maxAudioSize) {
      clearTimeout(timeout)
      return NextResponse.json(
        { error: `Fichier audio trop volumineux (${Math.round(audioFile.size / 1024 / 1024)}MB). Maximum: 4MB` },
        { status: 413 }
      )
    }

    // Extraire et valider les documents
    const documentCountRaw = formData.get('documentCount')
    const documentCount = documentCountRaw ? parseInt(String(documentCountRaw)) : 0

    const documents: Array<{type: 'inline' | 'text', name: string, mimeType?: string, data?: string, content?: string}> = []
    let totalSize = audioFile.size

    for (let i = 0; i < documentCount; i++) {
      const docFile = formData.get(`document_${i}`) as File
      if (!docFile) {
        console.warn(`⚠️ document_${i} est null/undefined`)
        continue
      }

      totalSize += docFile.size
      if (totalSize > maxTotalSize) {
        clearTimeout(timeout)
        return NextResponse.json(
          { error: `Taille totale dépassée (${Math.round(totalSize / 1024 / 1024)}MB). Maximum: 30MB` },
          { status: 413 }
        )
      }

      const fileName = docFile.name.toLowerCase()
      const mimeType = docFile.type

      // Traiter PDF et images comme données inline
      if (mimeType === 'application/pdf' || mimeType.startsWith('image/')) {
        const arrayBuffer = await docFile.arrayBuffer()
        const base64Data = Buffer.from(arrayBuffer).toString('base64')
        documents.push({
          type: 'inline',
          name: docFile.name,
          mimeType: mimeType,
          data: base64Data
        })
      }
      // Extraire texte des DOCX
      else if (fileName.endsWith('.docx') && mammoth) {
        try {
          const arrayBuffer = await docFile.arrayBuffer()
          const result = await mammoth.extractRawText({ arrayBuffer })
          documents.push({
            type: 'text',
            name: docFile.name,
            content: result.value
          })
        } catch (e) {
          console.warn(`Erreur extraction DOCX ${docFile.name}:`, e)
        }
      }
      // Extraire texte des XLSX
      else if (fileName.endsWith('.xlsx') && ExcelJS) {
        try {
          const arrayBuffer = await docFile.arrayBuffer()

          const workbook = new ExcelJS.Workbook()
          await workbook.xlsx.load(arrayBuffer)

          let sheetText = ''
          workbook.worksheets.forEach((worksheet: any) => {
            sheetText += `\n=== ${worksheet.name} ===\n`
            worksheet.eachRow((row: any) => {
              const rowValues = row.values
                .slice(1) // Skip first element (row index)
                .map((val: any) => val?.toString() || '')
                .join(',')
              sheetText += rowValues + '\n'
            })
          })

          documents.push({
            type: 'text',
            name: docFile.name,
            content: sheetText
          })
        } catch (e) {
          console.error(`❌ Erreur extraction XLSX ${docFile.name}:`, e)
        }
      } else if (fileName.endsWith('.xlsx')) {
        console.warn(`⚠️ XLSX détecté mais ExcelJS non disponible: ${docFile.name}`)
      }
    }

    // Convertir le fichier en base64
    const arrayBuffer = await audioFile.arrayBuffer()
    const audioData = Buffer.from(arrayBuffer).toString('base64')

    const audioPart = {
      inlineData: {
        data: audioData,
        mimeType: audioFile.type
      }
    }

    // Créer le prompt selon le mode (nouveau ou complément)
    let prompt: string
    let documentReferences = ''

    // Construire les références aux documents avec instructions explicites
    if (documents.length > 0) {
      documentReferences = `

DOCUMENTS DE RÉFÉRENCE JOINTS :
Les documents suivants ont été joints par l'utilisateur. Tu DOIS les lire attentivement et utiliser leur contenu pour enrichir ta rédaction. L'audio contient les instructions vocales, les documents fournissent le contexte et les données de référence.
`
      documents.forEach((doc, index) => {
        if (doc.type === 'text') {
          documentReferences += `
--- ${doc.name} ---
${doc.content}
`
        } else {
          documentReferences += `
--- ${doc.name} (document PDF/image) ---
(document joint en pièce jointe — analyse son contenu visuel et utilise-le dans ta rédaction)
`
        }
      })
    }

    if (existingText && existingText.trim()) {
      // Mode complément
      console.log(`📝 Mode: COMPLÉMENT`)
      prompt = `Tu es un assistant de rédaction expert. Tu as déjà produit ce texte :

==================
TEXTE EXISTANT :
${existingText}
==================

Dans ce fichier audio, la personne te donne des instructions pour MODIFIER/COMPLÉTER ce texte existant.

Les instructions peuvent être :
- Modifier le formatage (mettre en gras, italique, etc.)
- Ajouter de nouvelles informations
- Réorganiser le contenu
- Changer le style ou le ton
- Corriger ou préciser certains points
- Continuer le texte avec de nouveaux éléments${documentReferences}

TON RÔLE :
1. Prendre le TEXTE EXISTANT ci-dessus comme base
2. Appliquer EXACTEMENT les instructions données dans l'audio
3. Si c'est un changement de formatage : appliquer le formatage au texte existant
4. Si c'est un ajout : intégrer harmonieusement avec le texte existant
5. Si des documents de référence sont joints, les analyser et intégrer leur contenu selon les instructions audio
6. Produire un texte COMPLET qui respecte les nouvelles instructions

IMPORTANT :
- Réponds UNIQUEMENT avec le texte final modifié/complété
- N'ajoute AUCUNE explication du type "voici le texte modifié"
- Applique les instructions à la lettre
- Garde tout le contenu original sauf si explicitement demandé de le changer`
    } else {
      // Mode création classique
      console.log(`📝 Mode: CRÉATION`)
      prompt = `Tu es un assistant de rédaction expert. Dans ce fichier audio, la personne te donne un brief oral contenant :

CONSIGNES possibles :
- Type de contenu (email, article, présentation, rapport, etc.)
- Ton et style (professionnel, décontracté, commercial, académique...)
- Longueur souhaitée
- Public cible
- Objectif du texte

CONTENU à rédiger :
- Informations factuelles
- Idées principales à développer
- Points clés à mettre en avant
- Structure souhaitée${documentReferences}

TON RÔLE :
1. Analyser le brief oral pour identifier les consignes et le contenu
2. Rédiger un texte cohérent et bien structuré selon ces consignes
3. Adapter le style et le ton aux demandes exprimées
4. Si des documents de référence sont joints, les analyser en détail et utiliser leur contenu comme base de données pour ta rédaction
5. Extraire les informations pertinentes des documents pour répondre aux instructions vocales
6. Sauf indication contraire, formater le texte pour être prêt à copier coller dans un editeur de texte ou slack

IMPORTANT : Réponds uniquement avec le texte final rédigé, prêt à être utilisé. Si les consignes sont imprécises, fais de ton mieux pour interpréter l'intention et rédige un contenu de qualité.`
    }

    // Log pour vérifier que les documents sont dans le prompt
    const hasDocumentsInPrompt = prompt.includes('DOCUMENTS DE RÉFÉRENCE JOINTS')
    console.log(`📝 Prompt contient les documents: ${hasDocumentsInPrompt}`)
    console.log(`📝 Longueur du prompt: ${prompt.length} caractères`)

    // Utiliser uniquement Gemini Flash
    const modelName = 'gemini-3-flash-preview'
    const model = genAI.getGenerativeModel({ model: modelName })

    // Construire les parts pour generateContent
    const contentParts: any[] = [prompt, audioPart]
    console.log(`📤 Envoi à Gemini: prompt + audio + ${documents.filter(d => d.type === 'inline').length} document(s) inline`)

    // Ajouter les documents inline (PDF et images)
    documents.forEach(doc => {
      if (doc.type === 'inline' && doc.data && doc.mimeType) {
        contentParts.push({
          inlineData: {
            data: doc.data,
            mimeType: doc.mimeType
          }
        })
      }
    })

    let result: any
    try {
      result = await model.generateContent(contentParts)
    } catch (error: any) {
      console.log(`Erreur avec ${modelName}:`, error.message)

      // Si erreur retryable
      const isRetryableError = error.message?.includes('503') ||
                             error.message?.includes('overloaded') ||
                             error.message?.includes('500') ||
                             error.message?.includes('502') ||
                             error.message?.includes('504') ||
                             error.message?.includes('timeout') ||
                             error.message?.includes('network')

      if (isRetryableError) {
        // Retry simple avec délai
        console.log('⏳ Serveur surchargé, nouvelle tentative dans 3s...')
        await new Promise(resolve => setTimeout(resolve, 3000))
        result = await model.generateContent(contentParts)
      } else {
        throw error
      }
    }
    clearTimeout(timeout)
    
    if (!result) {
      throw new Error('Aucune réponse du modèle')
    }
    
    const generatedText = result.response.text()
    
    if (!generatedText || generatedText.trim().length === 0) {
      throw new Error('Réponse vide du modèle')
    }
    
    // Récupérer les métadonnées d'usage
    const usageMetadata = result.response.usageMetadata || {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0
    }
    
    // Calculer le coût en euros (prix 2025 - Gemini Flash uniquement)
    const pricing = { input: 1.0, output: 3 } // Flash: $0.30/$2.5 per 1M tokens

    const divisor = 1000000 // Facturé par 1M tokens
    const inputCostUSD = (usageMetadata.promptTokenCount || 0) * pricing.input / divisor
    const outputCostUSD = (usageMetadata.candidatesTokenCount || 0) * pricing.output / divisor
    const totalCostUSD = inputCostUSD + outputCostUSD
    const totalCostEUR = totalCostUSD * 0.92 // Approximation USD->EUR

    console.log(`✅ Transcription réussie (${Math.round(audioFile.size / 1024)}KB -> ${generatedText.length} chars, ${modelName})`)
    
    return NextResponse.json({
      success: true,
      content: generatedText.trim(),
      cost: {
        totalEUR: totalCostEUR,
        totalUSD: totalCostUSD,
        inputTokens: usageMetadata.promptTokenCount || 0,
        outputTokens: usageMetadata.candidatesTokenCount || 0,
        model: modelName
      },
      timestamp: new Date().toISOString()
    })

  } catch (error: any) {
    console.error('❌ Erreur lors de la rédaction:', error)
    
    // Messages d'erreur plus spécifiques
    let errorMessage = error.message || 'Erreur inconnue'
    let statusCode = 500
    
    if (error.message?.includes('The string did not match the expected pattern')) {
      errorMessage = 'Format audio non supporté ou fichier corrompu'
      statusCode = 400
    } else if (error.message?.includes('Request Entity Too Large')) {
      errorMessage = 'Fichier audio trop volumineux'
      statusCode = 413
    } else if (error.message?.includes('timeout') || error.message?.includes('AbortError')) {
      errorMessage = 'Timeout: le fichier audio est trop long à traiter'
      statusCode = 408
    } else if (error.message?.includes('429') || error.message?.includes('quota')) {
      errorMessage = 'Quota API dépassé, réessayez plus tard'
      statusCode = 429
    }
    
    return NextResponse.json(
      {
        success: false,
        error: errorMessage
      },
      { status: statusCode }
    )
  }
}