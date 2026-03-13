# 🎙️ VoixLà

Application Next.js de transcription vocale utilisant l'API Gemini de Google.

## ✨ Fonctionnalités

- 🎤 **Enregistrement vocal** en temps réel
- 🤖 **Deux modèles IA** : Gemini Flash (rapide) et Pro (précis)  
- 💰 **Calcul de coût** en temps réel
- 🔄 **Retry automatique** en cas d'erreur API
- 📋 **Copie** dans le presse-papier
- 📱 **Interface responsive**

## 🚀 Déploiement sur Vercel

### 1. Fork ce repository

### 2. Connecter à Vercel
- Aller sur [vercel.com](https://vercel.com)
- Importer votre repository GitHub
- Vercel détecte automatiquement Next.js

### 3. Configurer les variables d'environnement
Dans les settings Vercel, ajouter :
```
GEMINI_API_KEY = votre_cle_api_gemini
```

### 4. Déployer
Le déploiement est **automatique** ! ✅

## 🛠️ Développement local

```bash
# Installer les dépendances
npm install

# Créer .env.local avec votre clé API
echo "GEMINI_API_KEY=votre_cle" > .env.local

# Lancer le serveur de dev
npm run dev
```

Ouvrir [http://localhost:3000](http://localhost:3000)

## 📱 Utilisation

1. **Cliquer** sur le bouton microphone
2. **Parler** votre brief/mémo
3. **Choisir** le modèle (Flash=rapide, Pro=précis)
4. **Récupérer** le texte transcrit
5. **Copier** dans le presse-papier

## 💡 Tips

- **Flash** : Idéal pour des notes rapides
- **Pro** : Meilleur pour du contenu important
- Le **coût** s'affiche automatiquement
- **Retry** automatique si le serveur est surchargé

## 🔧 Technologies

- **Next.js 15** (App Router)
- **React 19** 
- **TypeScript**
- **Google Gemini API**
- **CSS Modules**

## Notes

```
mcp add-json github '{"type":"http","url":"https://api.githubcopilot.com/mcp","headers":{"Authorization":"Bearer PAT"}}'
```