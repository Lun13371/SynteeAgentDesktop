import { memo } from 'react'
import { motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import ModelPicker from '../ModelPicker/ModelPicker'
import ReasoningSelector from '../ReasoningSelector/ReasoningSelector'
import { useSettingsStore } from '../../../store/settings.store'
import type { OrchestrationModel, OrchestrationSelection } from '../../../../../shared/orchestration'
import { validateOrchestration, type OrchestrationIssueText } from '../../../utils/orchestration'

/**
 * Компактный блок оркестрации над инпутом (`/orchestrate` или «+» → Оркестрация).
 *
 * Это НЕ режим-тумблер: выбор живёт один ход — после принятой отправки блок
 * закрывается. Модель чата остаётся основной (координатор), здесь задаются
 * только исполнитель (обязателен) и ревьюер (опционален, по умолчанию —
 * модель чата).
 */
interface OrchestrationBarProps {
  selection: OrchestrationSelection
  /** Проблема отправки/валидации — показывается строкой внутри блока. */
  error?: OrchestrationIssueText | null
  /** Основная модель чата — подпись для «как основная» и fallback-ревьюера. */
  mainModelId?: string
  mainModelProviderId?: string
  onExecutorChange: (model: OrchestrationModel) => void
  onReviewerChange: (model: OrchestrationModel | null) => void
  onClose: () => void
}

function OrchestrationBar({
  selection,
  error,
  mainModelId = '',
  mainModelProviderId = '',
  onExecutorChange,
  onReviewerChange,
  onClose,
}: OrchestrationBarProps) {
  const lang = useSettingsStore(s => (s.settings['language'] as 'ru' | 'en') ?? 'ru')
  const t = (ru: string, en: string) => (lang === 'en' ? en : ru)

  const reviewerDefault = mainModelId
    ? t(`Как основная (${mainModelId})`, `Same as main (${mainModelId})`)
    : t('Как основная модель', 'Same as main model')

  // Причина блокировки видна СРАЗУ (а не только после попытки отправки):
  // без исполнителя отправка заблокирована, и пользователь должен понимать
  // почему — кнопка отправки в этом состоянии недоступна (ChatInput).
  const shownError = error ?? validateOrchestration(selection)
  const executor = selection.executor
  const reviewer = selection.reviewer

  return (
    <motion.div
      className="chat-orch-bar"
      initial={{ opacity: 0, y: 6, height: 0 }}
      animate={{ opacity: 1, y: 0, height: 'auto' }}
      exit={{ opacity: 0, y: 6, height: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      role="group"
      aria-label={t('Настройки оркестрации на один ход', 'One-turn orchestration settings')}
    >
      <div className="chat-orch-head">
        <span className="chat-orch-head-icon"><AppIcon name="layers" size="xs" tone="accent" /></span>
        <span className="chat-orch-title">{t('Оркестрация', 'Orchestration')}</span>
        <span className="chat-orch-badge">{t('один ход', 'one turn')}</span>
        <span className="chat-orch-main">
          {t('Координатор', 'Coordinator')}: <b>{mainModelId || '—'}</b>
        </span>
        <button
          type="button"
          className="chat-orch-close"
          onClick={onClose}
          title={t('Выключить оркестрацию', 'Turn orchestration off')}
          aria-label={t('Выключить оркестрацию', 'Turn orchestration off')}
        >
          <AppIcon name="x" size="xs" />
        </button>
      </div>

      <div className="chat-orch-row">
        <div className="chat-orch-role">
          <span className="chat-orch-role-label">
            {t('Исполнитель', 'Executor')}
            <em className="chat-orch-required" title={t('Обязательное поле', 'Required')}>*</em>
          </span>
          <div className="chat-orch-field">
            <div className="chat-orch-picker">
              <ModelPicker
                value={executor?.modelId ?? ''}
                providerId={executor?.providerId ?? mainModelProviderId}
                onChange={(modelId, providerId) => onExecutorChange({
                  providerId,
                  modelId,
                  // Effort переживает повторный выбор той же модели, но не
                  // переезжает на другую: уровни у моделей разные.
                  reasoningValue: executor?.modelId === modelId ? executor?.reasoningValue : undefined,
                })}
                placeholder={t('Выберите модель', 'Pick a model')}
              />
            </div>
            {/* Effort исполнителя — тот же селектор мышления, что у модели чата
                (существующий компонент; null, если модель без reasoning).
                В одном ряду с пикером: иначе колонки ролей разъезжаются по
                высоте и вторая роль «съезжает» вниз. */}
            {executor?.modelId && (
              <div className="chat-orch-effort">
                <ReasoningSelector
                  modelId={executor.modelId}
                  value={executor.reasoningValue ?? ''}
                  onChange={(v) => onExecutorChange({
                    providerId: executor?.providerId ?? '',
                    modelId: executor?.modelId ?? '',
                    reasoningValue: v || undefined,
                  })}
                />
              </div>
            )}
          </div>
        </div>

        <div className="chat-orch-role">
          <span className="chat-orch-role-label">{t('Ревьюер', 'Reviewer')}</span>
          <div className="chat-orch-field">
            <div className="chat-orch-picker">
              <ModelPicker
                value={reviewer?.modelId ?? ''}
                providerId={reviewer?.providerId ?? ''}
                onChange={(modelId, providerId) => onReviewerChange({
                  providerId,
                  modelId,
                  reasoningValue: reviewer?.modelId === modelId ? reviewer?.reasoningValue : undefined,
                })}
                placeholder={reviewerDefault}
              />
            </div>
            {reviewer?.modelId && (
              <div className="chat-orch-effort">
                <ReasoningSelector
                  modelId={reviewer.modelId}
                  value={reviewer.reasoningValue ?? ''}
                  onChange={(v) => onReviewerChange({
                    providerId: reviewer?.providerId ?? '',
                    modelId: reviewer?.modelId ?? '',
                    reasoningValue: v || undefined,
                  })}
                />
              </div>
            )}
          </div>
          {reviewer && (
            <button
              type="button"
              className="chat-orch-reset"
              onClick={() => onReviewerChange(null)}
              title={t('Вернуть ревьюера к основной модели', 'Fall back to the main model')}
            >
              {t('Как основная', 'Same as main')}
            </button>
          )}
        </div>
      </div>

      {shownError && (
        <div className="chat-orch-error" role="alert">
          <AppIcon name="alertTriangle" size="xs" />
          <span>{t(shownError.ru, shownError.en)}</span>
        </div>
      )}
    </motion.div>
  )
}

export default memo(OrchestrationBar)
