import ReactDOM from 'react-dom/client'
import '@/index.css'
import './manual.css'
import ManualScreenshotsApp from './ManualScreenshotsApp'
import { installManualMocks } from './mockApi'
import { manualUser } from './mockData'
import { useAuthStore } from '@/store/authStore'

const scene = document.body.dataset.scene || inferSceneFromPath()

sessionStorage.setItem('splash_shown', '1')
localStorage.setItem('userId', manualUser.userId)
useAuthStore.getState().setUser(manualUser)
installManualMocks(scene)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ManualScreenshotsApp scene={scene} />,
)

function inferSceneFromPath() {
  return window.location.pathname.split('/').pop()?.replace(/\.html$/, '') || 'home-dashboard'
}
