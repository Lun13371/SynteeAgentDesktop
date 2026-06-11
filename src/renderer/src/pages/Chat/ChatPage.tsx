import TitleBar from '../../components/layout/TitleBar/TitleBar'
import Sidebar from '../../components/layout/Sidebar/Sidebar'
import './ChatPage.css'

export default function ChatPage() {
  return (
    <div className="chat-layout">
      <TitleBar />
      <div className="chat-body">
        <Sidebar />
        <main className="chat-main">
          <div className="chat-empty-state">
            <div className="chat-empty-icon">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                <polygon points="24,2 46,14 46,34 24,46 2,34 2,14"
                  fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.5"/>
                <polygon points="24,9 39,17 39,31 24,39 9,31 9,17"
                  fill="var(--accent)" opacity="0.06"/>
              </svg>
            </div>
            <h2>Привет! Я Syntee.</h2>
            <p>Чем могу помочь?</p>
          </div>
        </main>
      </div>
    </div>
  )
}
