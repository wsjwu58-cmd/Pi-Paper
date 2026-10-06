import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { toastError } from '@/components/ui/Toast'
import { AuthShell } from './AuthShell'

export function RegisterPage() {
  const register = useAuth((s) => s.register)
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await register(email, password, nickname, inviteCode || undefined)
      navigate('/workspace')
    } catch (err) {
      toastError(err instanceof Error ? err.message : '注册失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="创建账号" subtitle="注册即得默认画布，开始你的 AI 原生创作">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="邮箱">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@example.com" />
        </Field>
        <Field label="昵称">
          <Input value={nickname} onChange={(e) => setNickname(e.target.value)} required placeholder="创作家" />
        </Field>
        <Field label="密码（至少 6 位）">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        </Field>
        <Field label="邀请码（选填）">
          <Input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="ABCD1234" />
        </Field>
        <Button type="submit" disabled={busy} className="mt-2 w-full">
          {busy ? '注册中…' : '注册'}
        </Button>
        <p className="text-center text-[13px] text-[#666]">
          已有账号？{' '}
          <Link to="/login" className="font-bold text-[#111] underline-offset-2 hover:underline">
            去登录
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}
