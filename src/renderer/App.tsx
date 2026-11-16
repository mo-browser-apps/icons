import { ThemeProvider } from "@/components/theme-provider"
import { AppContent } from "@/components/app-content"
import { IconPreviewToolbar } from "@/components/icon-preview-toolbar"

function App() {
  if (location.hash === '#icon-preview-toolbar') return <IconPreviewToolbar />
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  )
}

export default App
