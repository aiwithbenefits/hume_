'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Hume, HumeClient, convertBlobToBase64, convertBase64ToBlob, ensureSingleValidAudioTrack, getAudioStream, getBrowserSupportedMimeType, MimeType } from 'hume'

export default function VoiceAssistant() {
  const [isConnected, setIsConnected] = useState(false)
  const [messages, setMessages] = useState<Array<{role: string, content: string, emotions: Array<{emotion: string, score: string}>}>>([])
  const [isRecording, setIsRecording] = useState(false)
  const chatRef = useRef<HTMLDivElement>(null)

  const clientRef = useRef<HumeClient | null>(null)
  const socketRef = useRef<Hume.empathicVoice.chat.ChatSocket | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const audioQueueRef = useRef<Blob[]>([])
  const chatGroupIdRef = useRef<string | undefined>(undefined)

  const mimeType = getBrowserSupportedMimeType().success ? getBrowserSupportedMimeType().mimeType : MimeType.WEBM

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight
    }
  }, [messages])

  const connect = async () => {
    if (!clientRef.current) {
      clientRef.current = new HumeClient({
        apiKey: process.env.NEXT_PUBLIC_HUME_API_KEY || '',
        secretKey: process.env.NEXT_PUBLIC_HUME_SECRET_KEY || '',
      })
    }

    const tools: Hume.empathicVoice.Tool[] = [
      {
        type: Hume.empathicVoice.ToolType.Function,
        name: 'send_message',
        parameters: JSON.stringify({
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message to send',
            },
          },
          required: ['message'],
        }),
        description: 'Sends a message to the specified endpoint.',
      },
    ]

    socketRef.current = await clientRef.current.empathicVoice.chat.connect({
      configId: process.env.NEXT_PUBLIC_HUME_CONFIG_ID || null,
      resumedChatGroupId: chatGroupIdRef.current,
      tools,
    })

    socketRef.current.on('open', handleWebSocketOpenEvent)
    socketRef.current.on('message', handleWebSocketMessageEvent)
    socketRef.current.on('error', handleWebSocketErrorEvent)
    socketRef.current.on('close', handleWebSocketCloseEvent)

    setIsConnected(true)
  }

  const disconnect = () => {
    setIsConnected(false)
    stopAudio()
    recorderRef.current?.stop()
    recorderRef.current = null
    audioStreamRef.current = null

    socketRef.current?.close()
  }

  const captureAudio = async () => {
    audioStreamRef.current = await getAudioStream()
    ensureSingleValidAudioTrack(audioStreamRef.current)

    recorderRef.current = new MediaRecorder(audioStreamRef.current, { mimeType })

    recorderRef.current.ondataavailable = async ({ data }) => {
      if (data.size < 1) return

      const encodedAudioData = await convertBlobToBase64(data)

      const audioInput: Omit<Hume.empathicVoice.AudioInput, 'type'> = {
        data: encodedAudioData,
      }

      socketRef.current?.sendAudioInput(audioInput)
    }

    const timeSlice = 100
    recorderRef.current.start(timeSlice)
    setIsRecording(true)
  }

  const handleWebSocketMessageEvent = async (message: Hume.empathicVoice.SubscribeEvent) => {
    switch (message.type) {
      case 'chat_metadata':
        chatGroupIdRef.current = message.chatGroupId
        break
      case 'user_message':
      case 'assistant_message':
        const { role, content } = message.message
        const topThreeEmotions = extractTopThreeEmotions(message)
        setMessages(prev => [...prev, { role, content: content || '', emotions: topThreeEmotions }])
        break
      case 'audio_output':
        const audioOutput = message.data
        const blob = convertBase64ToBlob(audioOutput, mimeType)
        audioQueueRef.current.push(blob)
        if (audioQueueRef.current.length >= 1) playAudio()
        break
      case 'tool_call':
        if (message.name === 'send_message') {
          const { message: messageToSend } = JSON.parse(message.parameters)

          try {
            const response = await sendMessageToEndpoint(messageToSend)
            socketRef.current?.sendToolResponseMessage({
              toolCallId: message.toolCallId,
              content: JSON.stringify({ content: response }),
            })
          } catch (error) {
            socketRef.current?.sendToolErrorMessage({
              toolCallId: message.toolCallId,
              error: error.message,
              code: 'message_send_error',
              level: 'warn',
              content: 'There was an error sending the message.',
            })
          }
        }
        break
      case 'user_interruption':
        stopAudio()
        break
    }
  }

  const sendMessageToEndpoint = async (message: string): Promise<string> => {
    const url = new URL('http://localhost:8000/agent/general_agent/run')
    url.searchParams.append('message', message)
    url.searchParams.append('stream', 'false')
    url.searchParams.append('monitor', 'false')

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      redirect: 'follow',
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const data = await response.json()
    return data.content
  }

  const handleWebSocketErrorEvent = (error: Error) => {
    console.error(error)
  }

  const handleWebSocketCloseEvent = async () => {
    if (isConnected) await connect()
    console.log('Web socket connection closed')
  }

  const extractTopThreeEmotions = (message: Hume.empathicVoice.UserMessage | Hume.empathicVoice.AssistantMessage) => {
    const scores = message.models.prosody?.scores
    const scoresArray = Object.entries(scores || {})
    scoresArray.sort((a, b) => b[1] - a[1])
    return scoresArray.slice(0, 3).map(([emotion, score]) => ({
      emotion,
      score: (Math.round(Number(score) * 100) / 100).toFixed(2),
    }))
  }

  const handleWebSocketOpenEvent = async () => {
    await captureAudio()
    console.log('Web socket connection opened')
  }

  const playAudio = async () => {
    if (currentAudioRef.current || audioQueueRef.current.length === 0) return

    const blob = audioQueueRef.current.shift()

    if (blob) {
      const url = URL.createObjectURL(blob)
      currentAudioRef.current = new Audio(url)
      currentAudioRef.current.onended = () => {
        URL.revokeObjectURL(url)
        currentAudioRef.current = null
        playAudio()
      }
      currentAudioRef.current.play()
    }
  }

  const stopAudio = () => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause()
      currentAudioRef.current.currentTime = 0
      currentAudioRef.current = null
    }
    audioQueueRef.current = []
  }

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Hume Voice Assistant</h1>
      <div className="flex-grow overflow-auto mb-4 p-4 border rounded-lg" ref={chatRef}>
        {messages.map((msg, index) => (
          <Card key={index} className={`mb-2 ${msg.role === 'user' ? 'bg-blue-100' : 'bg-green-100'}`}>
            <CardContent className="p-4">
              <p className="font-semibold">{msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}</p>
              <p>{msg.content}</p>
              <div className="mt-2">
                {msg.emotions.map((emotion, i) => (
                  <span key={i} className="mr-2 text-sm">
                    {emotion.emotion}: <strong>{emotion.score}</strong>
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="flex justify-between">
        <Button onClick={isConnected ? disconnect : connect}>
          {isConnected ? 'Disconnect' : 'Connect'}
        </Button>
        <Button disabled={!isConnected} onClick={() => setIsRecording(!isRecording)}>
          {isRecording ? 'Stop Recording' : 'Start Recording'}
        </Button>
      </div>
    </div>
  )
}